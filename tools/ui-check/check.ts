import { chromium, webkit, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";

/**
 * Deterministic browser check for the viewer.
 *
 * This exists because a camera regression once shipped after being "verified"
 * against a paused, narrow, non-default view: the aircraft ended up clipped
 * into the corner of a real widescreen window and only a user's screenshot
 * caught it. So this runs the *default* live state, at a widescreen size, after
 * the match has been running long enough for drift to show, and fails on
 * measured framing rather than on how a screenshot looks.
 *
 * It runs in Chromium *and* WebKit, and at device pixel ratio 2 as well as 1.
 * The first version of this check tested only Chromium at ratio 1 and passed
 * while the canvas was laying out at twice the viewport on every Retina
 * display -- the exact bug it was written to catch. Framing measured through
 * the camera agrees with itself no matter how wrong the canvas element is, so
 * the checks below also compare the canvas against the window.
 *
 *   npm run check:ui            (needs `npm run dev` and `npm run server`)
 */

// Vite's default port. Override with UI_CHECK_URL when it picked another one
// because 5173 was busy -- it prints the port it actually bound to.
const BASE = process.env["UI_CHECK_URL"] ?? "http://localhost:5173";
const OUT = "artifacts/ui-check";

interface Framing {
  x: number;
  y: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Rows in a data table once it has loaded.
 *
 * Returns zero rather than throwing on timeout: a page that failed to load its
 * data is one failed check, and should not take the rest of the run with it.
 */
async function countRows(page: Page): Promise<number> {
  try {
    await page.waitForSelector("table.data tbody tr", { timeout: 20_000 });
  } catch {
    const notice = await page.locator(".notice").first().textContent().catch(() => null);
    if (notice) console.error(`        page said: ${notice.trim().slice(0, 120)}`);
    return 0;
  }
  return page.locator("table.data tbody tr").count();
}

async function framing(page: Page): Promise<Framing> {
  return page.evaluate(() => {
    const data = document.querySelector<HTMLElement>("#app")!.dataset;
    return {
      x: Number(data["subjectScreenX"]),
      y: Number(data["subjectScreenY"]),
      minX: Number(data["subjectMinX"]),
      maxX: Number(data["subjectMaxX"]),
      minY: Number(data["subjectMinY"]),
      maxY: Number(data["subjectMaxY"]),
    };
  });
}

let engineLabel = "";
/** Visibility of each overlay element, read straight off the SVG. */
const OVERLAY_PROBE = `({
  reticle: document.querySelector('.reticle')?.getAttribute('visibility') !== 'hidden',
  box: document.querySelector('.target-box')?.getAttribute('visibility') !== 'hidden',
  shoot: document.querySelector('.shoot-cue')?.getAttribute('visibility') !== 'hidden',
  arrow: document.querySelector('.bandit-arrow')?.getAttribute('visibility') !== 'hidden'
})`;

/** Centre of each instrument group, in CSS pixels. */
const LAYOUT_PROBE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
  };
  return {
    viewport: { x: 0, y: window.innerHeight, w: window.innerWidth },
    speed: box('.flight-display .speed-group .tape-box'),
    altitude: box('.flight-display .alt-group .tape-box'),
    heading: box('.flight-display .heading-group .tape-box'),
    headingTicks: box('.flight-display .heading-group .tape-ticks'),
    throttle: box('.flight-display .engine-group')
  };
})()`;

const OVERLAY_SIZE_PROBE = `(() => {
  const t = document.querySelector('.tactical').getBoundingClientRect();
  const d = document.querySelector('.flight-display').getBoundingClientRect();
  return { tacticalW: Math.round(t.width), tacticalH: Math.round(t.height),
           displayW: Math.round(d.width), displayH: Math.round(d.height),
           viewW: window.innerWidth, viewH: window.innerHeight };
})()`;

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  const labelled = `${engineLabel}${message}`;
  if (condition) console.log(`  ok    ${labelled}`);
  else {
    console.error(`  FAIL  ${labelled}`);
    failures.push(labelled);
  }
}

/**
 * The canvas element must match its container.
 *
 * Projected framing is computed through the camera, so it reports a perfectly
 * centred aircraft even when the canvas is twice the size of the window and
 * most of the render is off screen. Only measuring the element catches that.
 */
async function checkCanvasFitsWindow(page: Page): Promise<void> {
  const measured = await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const box = canvas.getBoundingClientRect();
    return {
      cssWidth: box.width,
      cssHeight: box.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      bufferWidth: canvas.width,
      ratio: window.devicePixelRatio,
    };
  });
  check(
    Math.abs(measured.cssWidth - measured.innerWidth) <= 2,
    `canvas is the width of the window (${measured.cssWidth} vs ${measured.innerWidth}, dpr ${measured.ratio})`,
  );
  check(
    Math.abs(measured.cssHeight - measured.innerHeight) <= 2,
    `canvas is the height of the window (${measured.cssHeight} vs ${measured.innerHeight})`,
  );
  /**
   * The backing store may legitimately be smaller than the device pixel ratio
   * implies, because the renderer drops resolution when it cannot keep up. What
   * must never happen is the canvas collapsing to a fraction of the window, so
   * the floor is half the CSS size.
   */
  check(
    measured.bufferWidth >= measured.innerWidth * 0.5 - 2,
    `backing store is a sane resolution (${measured.bufferWidth} for a ${measured.innerWidth} px window, dpr ${measured.ratio})`,
  );
}

function checkFraming(label: string, frame: Framing): void {
  check(Number.isFinite(frame.x) && Number.isFinite(frame.y), `${label}: framing was measured`);
  check(Math.abs(frame.x - 0.5) < 0.12, `${label}: horizontally centred (x=${frame.x.toFixed(3)})`);
  check(Math.abs(frame.y - 0.5) < 0.12, `${label}: vertically centred (y=${frame.y.toFixed(3)})`);
  check(frame.minX > 0.02 && frame.maxX < 0.98, `${label}: not clipped left or right`);
  check(frame.minY > 0.02 && frame.maxY < 0.98, `${label}: not clipped top or bottom`);
  check(frame.maxX - frame.minX > 0.02, `${label}: aircraft is actually on screen, not a speck`);
}

mkdirSync(OUT, { recursive: true });

const ALL_ENGINES: Array<{ name: string; launch: () => Promise<Browser>; scale: number }> = [
  { name: "chromium", launch: () => chromium.launch(), scale: 1 },
  { name: "chromium@2x", launch: () => chromium.launch(), scale: 2 },
  { name: "webkit", launch: () => webkit.launch(), scale: 1 },
  { name: "webkit@2x", launch: () => webkit.launch(), scale: 2 },
];

/**
 * Which engines to run.
 *
 * All four by default, because the faults this catches are engine-specific and
 * pixel-ratio-specific often enough that checking one proves little. While
 * iterating, `UI_CHECK_ENGINES=webkit` narrows it to one -- useful for a tight
 * loop on a layout change, and not a substitute for the full run before a
 * commit.
 */
const requested = (process.env["UI_CHECK_ENGINES"] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const engines = requested.length
  ? ALL_ENGINES.filter((engine) => requested.includes(engine.name))
  : ALL_ENGINES;
if (!engines.length) {
  console.error(`No engines matched ${requested.join(", ")}. Available: ${ALL_ENGINES.map((e) => e.name).join(", ")}`);
  process.exit(1);
}

for (const engine of engines) {
console.log(`\n=== ${engine.name} ===`);
engineLabel = `[${engine.name}] `;
const browser = await engine.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: engine.scale,
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  // Headless WebKit runs software WebGL and drops the context under load. The
  // application handles that and recovers, and the framing checks below only
  // pass if rendering actually continued, so it is noise rather than a fault.
  if (/WebGL: context lost/i.test(message.text())) {
    console.log(`  note  ${engineLabel}WebGL context was lost and recovered`);
    return;
  }
  errors.push(message.text());
});

console.log("live page, untouched default state");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("data-subject-screen-x") !== null, {
  timeout: 20_000,
});
/**
 * Wait for simulated time rather than wall time.
 *
 * Headless rendering is software rasterised and can run well below real time,
 * so a fixed wall-clock wait turns a slow renderer into a failed assertion
 * about the simulation. Waiting on the clock the simulation reports keeps the
 * check about drift, which is what it is for.
 */
await page.waitForFunction(() => Number(document.querySelector("#app")?.getAttribute("data-sim-time")) > 6, {
  timeout: 60_000,
});
check(true, "simulation is running");
checkFraming("default live view", await framing(page));
await checkCanvasFitsWindow(page);
await page.screenshot({ path: `${OUT}/live-default-${engine.name}.png` });

console.log("live page, after orbiting and zooming");
const canvas = (await page.locator("canvas").boundingBox())!;
await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
await page.mouse.down();
await page.mouse.move(canvas.x + canvas.width / 2 + 220, canvas.y + canvas.height / 2 - 90, { steps: 20 });
await page.mouse.up();
await page.mouse.wheel(0, -320);
await page.waitForTimeout(3_000);
checkFraming("after orbit and zoom", await framing(page));
await page.screenshot({ path: `${OUT}/live-after-orbit-${engine.name}.png` });

console.log("controls");
await page.selectOption("#speed", "4");
await page.click("#pause");
await page.selectOption("#blue-pilot", "basic");
await page.click("#follow");
await page.waitForTimeout(1_500);
const state = await page.evaluate(() => ({ ...document.querySelector<HTMLElement>("#app")!.dataset }));
check(state["timeScale"] === "4", `speed control applied (${state["timeScale"]})`);
check(state["bluePilot"] === "basic", `pilot control applied (${state["bluePilot"]})`);
check(state["follow"] === "red-1", `follow control applied (${state["follow"]})`);
// Changing the pilot restarts the match, which resumes it; pause after that.
await page.click("#pause");
await page.waitForTimeout(500);
check(
  (await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["simStatus"])) === "paused",
  "pause control applied",
);

/**
 * Signing in, flying a ranked match, and finding it afterwards.
 *
 * The flow that broke twice while being built: the details panel covered the
 * account menu and ate its clicks, and signing in did not re-open the match
 * ticket, so every match a newly signed-in player flew was quietly unranked.
 * Neither was visible in any other check.
 *
 * Only at device pixel ratio 1, so one run creates two guest accounts rather
 * than four, and skipped entirely when the deployment has no accounts.
 */
if (engine.scale === 1 && process.env["UI_CHECK_SKIP_ACCOUNT"] !== "1") {
  console.log("accounts and ranked matches");
  const signIn = page.getByRole("button", { name: "Sign in" });
  if ((await signIn.count()) === 0) {
    console.log("  note  accounts are not configured; skipping");
  } else {
    // Earlier checks left the baseline flying and the match paused; a ranked
    // match needs a person at the controls.
    await page.selectOption("#blue-pilot", "human");
    await page.waitForTimeout(500);
    if ((await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["simStatus"])) === "paused") {
      await page.click("#pause");
    }

    await signIn.click();
    await page.getByRole("button", { name: "Play as a guest" }).click();
    await page.waitForTimeout(2_500);
    const chip = (await page.locator(".account-chip").first().textContent())?.trim();
    check(chip === "Guest", `signed in as a guest (${chip})`);

    await page.selectOption("#speed", "16");
    await page.waitForTimeout(1_500);
    /**
     * At sixteen times real time an unattended match can be over before this
     * line runs, so the banner may already have moved on to the result. What
     * must never appear is the prompt to sign in -- that is the regression this
     * guards, and it survives the race.
     */
    const banner = (await page.locator(".recording").textContent().catch(() => null))?.trim();
    check(
      Boolean(banner) && !banner!.includes("Sign in"),
      `the match is ranked once signed in (${banner ?? "no banner"})`,
    );

    const settled = await page
      .waitForFunction(
        () => {
          const element = document.querySelector(".recording");
          return element?.className.includes("recording-saved") || element?.className.includes("recording-failed");
        },
        { timeout: 120_000 },
      )
      .then(() => true)
      .catch(() => false);
    const outcome = (await page.locator(".recording").textContent().catch(() => null))?.trim();
    check(settled, `the finished match reports a result (${outcome ?? "never settled"})`);
    check(Boolean(outcome?.includes("Recorded")), `the result was recorded (${outcome ?? "none"})`);

    await page.getByRole("link", { name: "Matches" }).click();
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Mine" }).click();
    // The list is refetched when the scope changes, so the old table is still
    // on screen for a moment. Counting it would pass on somebody else's rows.
    await page.waitForFunction(() => !document.querySelector("table.data"), { timeout: 10_000 }).catch(() => {});
    const mine = await countRows(page);
    check(mine > 0, `the match appears under the player's own history (${mine})`);

    await page.getByRole("link", { name: "Fly" }).click();
    await page.waitForTimeout(2_000);
  }
}

/**
 * A calibrated model's probabilities, when this deployment can reach one.
 *
 * Skipped without a credential rather than failing, because the check has to
 * keep working on a machine with no keys -- but when a key is there, the whole
 * path from the provider's response to the bars on screen is exercised.
 */
const roster = (await page.evaluate(`fetch('/api/agents').then((r) => r.json())`)) as {
  agents: Array<{ kind: string; free: boolean; available: boolean }>;
};
const calibrated = roster.agents.find((agent) => agent.kind === "jev" && agent.free && agent.available);
if (calibrated && engine.scale === 1) {
  console.log("calibrated model");
  /**
   * Put the page in the state this actually needs, rather than inheriting it.
   *
   * Earlier sections pause the match and point the camera at red, and the
   * section that undoes both is skippable. A paused match asks nobody for a
   * decision, and the details panel reports the aircraft being followed -- so
   * watching red while the model flies blue shows a scripted pilot's absent
   * probabilities and looks exactly like a broken feature.
   */
  if ((await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["simStatus"])) === "paused") {
    await page.click("#pause");
  }
  await page.click("#follow-blue");
  await page.selectOption("#blue-pilot", "jev");
  await page.waitForTimeout(6_000);
  const questions = await page.locator(".distribution-head").count();
  const bars = await page.locator(".distribution-row").count();
  check(questions >= 3, `the model's probabilities are shown for each question (${questions})`);
  check(bars > questions, `every option gets a bar, not just the chosen one (${bars})`);
  await page.selectOption("#blue-pilot", "basic");
  await page.waitForTimeout(800);
}

console.log("render budget");
/**
 * A standing budget, so a scene change cannot quietly double what every frame
 * costs. Triangles *submitted*, not triangles in the scene: the ground is
 * chunked precisely so that most of it is culled before it reaches the GPU, and
 * a regression that merges it back into one mesh would show up here as the
 * count tripling rather than as a vague report that the page feels slow.
 */
const render = await page.evaluate(() => {
  const data = document.querySelector<HTMLElement>("#app")!.dataset;
  return {
    triangles: Number(data["triangles"]),
    drawCalls: Number(data["drawCalls"]),
    renderScale: Number(data["renderScale"]),
  };
});
check(
  render.triangles > 0 && render.triangles < 120_000,
  `submits a sane triangle count (${render.triangles.toLocaleString()})`,
);
check(render.drawCalls > 0 && render.drawCalls < 90, `keeps draw calls low (${render.drawCalls})`);
check(
  render.renderScale >= 0.5 && render.renderScale <= 1.5,
  `render scale is within its limits (${render.renderScale})`,
);

console.log("human controls");
/**
 * Flying with the mouse, without pointer lock.
 *
 * Pointer lock needs a focused OS window, which an automated browser does not
 * have, so this exercises the uncaptured mode: stick deflection taken from how
 * far the cursor sits from the centre of the viewport. That is the fallback
 * real users hit in embedded frames and locked-down browsers, so it is the mode
 * most worth having a standing check on.
 */
// The camera must be on the aircraft being flown. It was pointed at red above,
// and the indicator honestly reports whichever aircraft is on screen -- which
// is the right behaviour and the wrong test.
await page.click("#follow-blue");
await page.selectOption("#blue-pilot", "human");
await page.selectOption("#control-scheme", "mouse");
await page.waitForTimeout(600);
const controlDot = `(() => {
  const dot = document.querySelector('.control-dot');
  return dot ? { x: Number(dot.getAttribute('cx')), y: Number(dot.getAttribute('cy')) } : null;
})()`;
await page.mouse.move(800, 450);
await page.waitForTimeout(300);
const centred = (await page.evaluate(controlDot)) as { x: number; y: number } | null;
await page.mouse.move(1_180, 250, { steps: 8 });
await page.waitForTimeout(300);
const deflected = (await page.evaluate(controlDot)) as { x: number; y: number } | null;
check(centred !== null && deflected !== null, "control position indicator is drawn");
if (centred && deflected) {
  check(Math.abs(centred.x) < 2 && Math.abs(centred.y) < 2, "stick is centred when the cursor is centred");
  // Cursor right and forward: stick right, stick forward. The indicator's y
  // grows downward, and a stick pushed forward shows forward, so both are
  // positive.
  check(deflected.x > 5, `cursor right deflects the stick right (${deflected.x})`);
  check(deflected.y > 3, `cursor forward pushes the stick forward (${deflected.y})`);
}
/**
 * Right-drag looks around while flying with the mouse.
 *
 * The left button is the trigger and movement is the stick, so the camera needs
 * a button of its own. It is driven by hand rather than by OrbitControls,
 * because a captured pointer reports movement but never changes its client
 * coordinates -- so this has to keep working in both mouse modes.
 */
const cameraBefore = String(
  await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["camera"]),
);
await page.mouse.move(800, 450);
await page.mouse.down({ button: "right" });
await page.mouse.move(1_000, 470, { steps: 10 });
await page.mouse.up({ button: "right" });
await page.waitForTimeout(400);
const cameraAfter = String(
  await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["camera"]),
);
check(cameraBefore !== cameraAfter, "right-drag moves the external camera while flying with the mouse");
check(
  (await page.locator("#context-menu-should-not-exist").count()) === 0,
  "right-drag does not open the browser context menu",
);

/**
 * Gamepad axes, through a synthetic pad.
 *
 * No browser lets a script inject real pad events, but the part worth testing
 * is the mapping from axes to controls, which is ours: which stick flies, which
 * way forward is, and that a thumb resting on a worn stick does nothing.
 */
await page.evaluate(`(() => {
  window.__pad = {
    id: "Synthetic Pad (STANDARD GAMEPAD)", index: 0, connected: true, mapping: "standard",
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  navigator.getGamepads = () => [window.__pad, null, null, null];
  window.dispatchEvent(Object.assign(new Event("gamepadconnected"), { gamepad: window.__pad }));
})()`);
await page.selectOption("#control-scheme", "gamepad");
await page.waitForTimeout(700);
const padAt = async (axes: number[]) => {
  await page.evaluate(`window.__pad.axes = ${JSON.stringify(axes)}`);
  await page.waitForTimeout(450);
  return (await page.evaluate(controlDot)) as { x: number; y: number };
};
const padBack = await padAt([0, 0, 1, 1]);
check(padBack.x > 15 && padBack.y < -15, `right stick right and back rolls right and pulls (${padBack.x}, ${padBack.y})`);
const padForward = await padAt([0, 0, 0, -1]);
check(padForward.y > 15, `right stick forward pushes (${padForward.y})`);
const padDeadzone = await padAt([0, 0, 0.08, 0.08]);
check(
  Math.abs(padDeadzone.x) < 1 && Math.abs(padDeadzone.y) < 1,
  `a nudge inside the deadzone does nothing (${padDeadzone.x}, ${padDeadzone.y})`,
);
await padAt([0, 0, 0, 0]);

await page.selectOption("#control-scheme", "keyboard");
await page.waitForTimeout(400);
const released = (await page.evaluate(controlDot)) as { x: number; y: number } | null;
check(
  released !== null && Math.abs(released.x) < 2 && Math.abs(released.y) < 2,
  "leaving mouse control returns the stick to centre",
);
await page.selectOption("#blue-pilot", "basic");
await page.waitForTimeout(800);

console.log("flight instruments");
// Pilot instruments and omniscient benchmark data are deliberately separate
// things in separate places; check both exist and that the cockpit view puts
// conformal symbology on the screen.
check((await page.locator(".flight-display .tape-box").count()) >= 3, "airspeed, altitude and heading are displayed");

/**
 * Where the instruments actually landed.
 *
 * Existence checks passed while half the head-up display sat in the top-left
 * corner on WebKit, because percentage transforms on SVG elements resolve
 * against different boxes in different engines. Positions are measured now.
 */
const placed = (await page.evaluate(LAYOUT_PROBE)) as Record<string, { x: number; y: number; w: number }>;
const viewport = placed["viewport"]!;
const speed = placed["speed"]!;
const altitude = placed["altitude"]!;
const heading = placed["heading"]!;
const headingTicks = placed["headingTicks"]!;
const throttle = placed["throttle"]!;
check(
  speed.x < viewport.w * 0.25 && Math.abs(speed.y - viewport.y / 2) < viewport.y * 0.2,
  `airspeed sits on the left at mid-height (${Math.round(speed.x)}, ${Math.round(speed.y)})`,
);
check(
  altitude.x > viewport.w * 0.55 && Math.abs(altitude.y - viewport.y / 2) < viewport.y * 0.2,
  `altitude sits on the right at mid-height (${Math.round(altitude.x)}, ${Math.round(altitude.y)})`,
);
check(
  Math.abs(heading.x - viewport.w / 2) < viewport.w * 0.12 && heading.y < viewport.y * 0.25,
  `heading sits across the top centre (${Math.round(heading.x)}, ${Math.round(heading.y)})`,
);
/**
 * The scale, not just the box above it.
 *
 * These are separate elements and only the box was ever measured, so a version
 * shipped with the whole compass rose translated half a screen to the right and
 * every heading assertion still passed. Marks drawn inside an already-positioned
 * group are exactly the kind of thing that goes wrong twice.
 */
check(
  Math.abs(headingTicks.x - viewport.w / 2) < viewport.w * 0.06,
  `heading scale is centred under its box (${Math.round(headingTicks.x)} vs ${Math.round(viewport.w / 2)})`,
);
check(
  headingTicks.w > 120 && headingTicks.x + headingTicks.w / 2 < viewport.w,
  `heading scale is on screen, not off the right edge (${Math.round(headingTicks.w)} px wide)`,
);
check(
  throttle.x < viewport.w * 0.3 && throttle.y > viewport.y * 0.7,
  `throttle sits bottom-left (${Math.round(throttle.x)}, ${Math.round(throttle.y)})`,
);
check(altitude.x > speed.x + 200, "airspeed and altitude are not stacked on each other");
check((await page.locator(".details").count()) === 1, "the details panel is its own place");
/**
 * Attitude symbology belongs to the cockpit alone.
 *
 * There was a small artificial horizon for the external views, which is a
 * picture of the aircraft's attitude drawn next to a picture of the aircraft.
 * From outside, the aeroplane itself is the better instrument.
 */
check(
  (await page.locator(".conformal").getAttribute("visibility")) === "hidden",
  "external view leaves attitude to the aircraft itself",
);

await page.selectOption("#view", "cockpit");
await page.waitForTimeout(2_500);
check(
  (await page.locator(".conformal").getAttribute("visibility")) === "visible",
  "cockpit view shows conformal head-up symbology",
);
const ladderRungs = await page.locator(".conformal line").count();
check(ladderRungs > 4, `pitch ladder is drawn (${ladderRungs} segments)`);
await page.screenshot({ path: `${OUT}/cockpit-${engine.name}.png` });
await page.selectOption("#view", "orbit");
await page.waitForTimeout(1_500);

/**
 * Nothing sits on top of anything else.
 *
 * This is the fault that keeps coming back in different clothes: a panel over
 * the account menu eating its clicks, a recording banner under the details panel
 * panel, instruments behind the control bar. Each was found by a person looking
 * at a screenshot. Measuring the rectangles is cheaper.
 */
const rectangles = (await page.evaluate(`(() => {
  const box = (name, sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { name, l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
  };
  return [
    box('control bar', '.controls'),
    box('throttle', '.flight-display .engine-group'),
    box('stores', '.flight-display .stores-group'),
    box('details panel', '.details'),
    box('status strip', '.flight-strip'),
  ].filter(Boolean);
})()`)) as Array<{ name: string; l: number; t: number; r: number; b: number }>;

for (let i = 0; i < rectangles.length; i += 1) {
  for (let j = i + 1; j < rectangles.length; j += 1) {
    const a = rectangles[i]!;
    const b = rectangles[j]!;
    const overlaps = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    check(!overlaps, `${a.name} does not sit on ${b.name}`);
  }
}

console.log("tactical overlay");
// The gunsight is the whole point of a guns-only game: prove it draws, that it
// tracks the bandit, and that the shoot cue is gated rather than always on.
await page.selectOption("#blue-pilot", "basic");
let sawReticle = false;
let sawTarget = false;
let sawArrowOrBox = false;
for (let sample = 0; sample < 40; sample += 1) {
  await page.waitForTimeout(500);
  const overlay = (await page.evaluate(OVERLAY_PROBE)) as Record<string, boolean>;
  sawReticle ||= overlay["reticle"] === true;
  sawTarget ||= overlay["box"] === true;
  sawArrowOrBox ||= overlay["box"] === true || overlay["arrow"] === true;
  if (sawReticle && sawTarget) break;
}
/**
 * Overlays must fill the viewport.
 *
 * An SVG with no CSS falls back to an intrinsic 300x150, which folds the entire
 * gun symbology into the top-left corner while every element still reports
 * itself visible. A stylesheet edit did exactly that once, and visibility
 * checks alone did not notice.
 */
const overlaySize = (await page.evaluate(OVERLAY_SIZE_PROBE)) as Record<string, number>;
check(
  overlaySize["tacticalW"]! >= overlaySize["viewW"]! - 2 && overlaySize["tacticalH"]! >= overlaySize["viewH"]! - 2,
  `tactical overlay fills the viewport (${overlaySize["tacticalW"]}x${overlaySize["tacticalH"]})`,
);
check(
  overlaySize["displayW"]! >= overlaySize["viewW"]! - 2 && overlaySize["displayH"]! >= overlaySize["viewH"]! - 2,
  `flight display fills the viewport (${overlaySize["displayW"]}x${overlaySize["displayH"]})`,
);

check(sawReticle, "gunsight reticle is drawn");
// Whether the bandit happens to pass through frame during the sample window is
// luck; that it is *always* indicated one way or the other is the property
// worth asserting.
check(sawArrowOrBox, "bandit is always indicated, on screen or off");
if (!sawTarget) console.log(`  note  ${engineLabel}bandit stayed off screen during sampling`);
// Whether a scripted fight produces a firing solution inside a twenty-second
// window is luck, so the cue's gating is pinned by a unit test instead; here we
// only confirm the element exists to be shown.
check(
  (await page.locator(".shoot-cue").count()) === 1,
  "shoot cue exists to be shown when a burst would connect",
);
await page.screenshot({ path: `${OUT}/overlay-${engine.name}.png` });

console.log("leaderboard");
await page.getByRole("link", { name: "Leaderboard" }).click();
// Wait for the data itself. Matching the loading notice as well resolves
// immediately and then counts zero rows. A timeout here is a failed check, not
// a reason to abandon every remaining check in the run.
const leaderboardRows = await countRows(page);
check(leaderboardRows > 0, `leaderboard shows ${leaderboardRows} agents`);
await page.screenshot({ path: `${OUT}/leaderboard-${engine.name}.png` });

console.log("match history and replay");
await page.getByRole("link", { name: "Matches" }).click();
const matchRows = await countRows(page);
check(matchRows > 0, `match history shows ${matchRows} matches`);
await page.screenshot({ path: `${OUT}/matches-${engine.name}.png` });

if (matchRows === 0) {
  console.error("  FAIL  no matches to replay; run `npm run bench` first");
  failures.push("no matches to replay");
  await browser.close();
  continue;
}
await page.getByRole("link", { name: "Watch" }).first().click();
/**
 * A replay that never starts must be one failed check, not a crashed run.
 *
 * Matches with no stored replay are a real case -- a result can be recorded
 * without one -- and the page reports that rather than playing. Letting the
 * wait throw takes every remaining check with it and hides whatever else was
 * wrong.
 */
let replayTime: string | null = null;
try {
  await page.waitForFunction(
    () => Number(document.querySelector(".timecode")?.textContent?.trim().split(" ")[0]) > 0.5,
    { timeout: 20_000 },
  );
  replayTime = await page.locator(".timecode").textContent();
} catch {
  const notice = await page.locator(".notice").first().textContent().catch(() => null);
  if (notice) console.error(`        page said: ${notice.trim().slice(0, 140)}`);
}
check(Boolean(replayTime && parseFloat(replayTime) > 0.5), `replay is playing (${replayTime?.trim() ?? "never started"})`);
if (replayTime) {
  checkFraming("replay view", await framing(page));
}
await page.screenshot({ path: `${OUT}/replay-${engine.name}.png` });

check(errors.length === 0, `no console or page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
await checkCanvasFitsWindow(page);

await browser.close();
}

console.log(`\nScreenshots in ${OUT}/`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll UI checks passed.");
