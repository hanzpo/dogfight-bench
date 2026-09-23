import { chromium, webkit, type Browser, type Page } from "playwright";
import { mkdirSync } from "node:fs";

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
const OVERLAY_PROBE = `({
  reticle: document.querySelector('.reticle')?.getAttribute('visibility') !== 'hidden',
  box: document.querySelector('.target-box')?.getAttribute('visibility') !== 'hidden',
  shoot: document.querySelector('.shoot-cue')?.getAttribute('visibility') !== 'hidden',
  arrow: document.querySelector('.bandit-arrow')?.getAttribute('visibility') !== 'hidden'
})`;

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

const BANDIT_PROBE = `(() => {
  const el = document.querySelector('.tactical .target-box');
  const shown = el && el.getAttribute('visibility') !== 'hidden';
  const r = el ? el.getBoundingClientRect() : null;
  return {
    shown: Boolean(shown),
    x: r ? r.x + r.width / 2 : null,
    y: r ? r.y + r.height / 2 : null,
    viewW: window.innerWidth,
    viewH: window.innerHeight,
  };
})()`;

const SHOT_PROBE = `(() => {
  const d = document.querySelector('#app').dataset;
  return {
    camera: (d.camera || '0,0,0').split(',').map(Number),
    subjectW: Number(d.subjectMaxX) - Number(d.subjectMinX),
    standoffM: Number(d.subjectDistance),
    fov: Number(d.fov),
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
  check(
    measured.bufferWidth >= measured.innerWidth * 0.5 - 2,
    `backing store is a sane resolution (${measured.bufferWidth} for a ${measured.innerWidth} px window, dpr ${measured.ratio})`,
  );
}

function checkFraming(label: string, frame: Framing): void {
  check(
    Math.abs(frame.x - 0.5) < 0.12 && Math.abs(frame.y - 0.5) < 0.12,
    `${label}: the aircraft is near the middle of the frame (${frame.x.toFixed(2)}, ${frame.y.toFixed(2)})`,
  );
  check(
    frame.minX > 0.02 && frame.maxX < 0.98 && frame.minY > 0.02 && frame.maxY < 0.98 && frame.maxX - frame.minX > 0.02,
    `${label}: the aircraft is on screen whole, and is not a speck`,
  );
}

mkdirSync(OUT, { recursive: true });

const ALL_ENGINES: Array<{ name: string; launch: () => Promise<Browser>; scale: number }> = [
  { name: "chromium", launch: () => chromium.launch(), scale: 1 },
  { name: "chromium@2x", launch: () => chromium.launch(), scale: 2 },
  { name: "webkit", launch: () => webkit.launch(), scale: 1 },
  { name: "webkit@2x", launch: () => webkit.launch(), scale: 2 },
];

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
  if (/WebGL: context lost/i.test(message.text())) {
    console.log(`  note  ${engineLabel}WebGL context was lost and recovered`);
    return;
  }
  errors.push(message.text());
});
/**
 * A failed request names the URL that failed.
 *
 * The console only says "Failed to load resource", which is the same message
 * whether the API refused a decision or an image was missing, and chasing one
 * of those on a deployed site with no URL to go on is not possible.
 *
 * A refused decision is counted rather than treated as a broken page: a model
 * that errors or returns something malformed is a result the benchmark exists
 * to record, and the leaderboard has a column for it. Only the rate is asserted.
 */
const decisions = { served: 0, refused: 0 };
page.on("response", (response) => {
  const decision = response.url().endsWith("/api/decide");
  if (decision) {
    decisions.served += 1;
    if (response.status() >= 500) decisions.refused += 1;
    return;
  }
  if (response.status() >= 500) errors.push(`HTTP ${response.status()} from ${response.url()}`);
});

console.log("live page, untouched default state");
await page.goto(`${BASE}/lab`, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.querySelector("#app")?.getAttribute("data-subject-screen-x") !== null, {
  timeout: 20_000,
});
await page.waitForFunction(() => Number(document.querySelector("#app")?.getAttribute("data-sim-time")) > 6, {
  timeout: 60_000,
});
check(true, "simulation is running");
checkFraming("default live view", await framing(page));
await checkCanvasFitsWindow(page);
await page.screenshot({ path: `${OUT}/live-default-${engine.name}.png` });

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
await page.click("#pause");
await page.waitForTimeout(500);
check(
  (await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["simStatus"])) === "paused",
  "pause control applied",
);

if (engine.scale === 1 && process.env["UI_CHECK_SKIP_ACCOUNT"] !== "1") {
  console.log("accounts and ranked matches");
  const signIn = page.getByRole("button", { name: "Sign in" });
  if ((await signIn.count()) === 0) {
    console.log("  note  accounts are not configured; skipping");
  } else {
    await page.selectOption("#blue-pilot", "human");
    await page.waitForTimeout(500);
    if ((await page.evaluate(() => document.querySelector<HTMLElement>("#app")!.dataset["simStatus"])) === "paused") {
      await page.click("#pause");
    }

    const notice = page.locator("button.recording");
    check((await notice.count()) === 1, "the 'not counted' notice is something you can act on");
    if (await notice.count()) {
      await notice.click();
      await page.waitForTimeout(400);
      check((await page.locator(".account-menu").count()) === 1, "it opens the sign-in menu");
    } else {
      await signIn.click();
    }
    await page.getByRole("button", { name: "Play as a guest" }).click();
    await page.waitForTimeout(2_500);
    const chip = (await page.locator(".account-chip").first().textContent())?.trim();
    check(chip === "Guest", `signed in as a guest (${chip})`);

    await page.selectOption("#speed", "16");
    await page.waitForTimeout(1_500);
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

    await page.getByRole("link", { name: "Replays", exact: true }).click();
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Mine" }).click();
    await page.waitForFunction(() => !document.querySelector("table.data"), { timeout: 10_000 }).catch(() => {});
    const mine = await countRows(page);
    check(mine > 0, `the match appears under the player's own history (${mine})`);

    await page.getByRole("link", { name: "Lab", exact: true }).click();
    await page.waitForTimeout(2_000);
  }
}

const roster = (await page.evaluate(`fetch('/api/agents').then((r) => r.json())`)) as {
  agents: Array<{ kind: string; free: boolean; available: boolean }>;
};
const calibrated = roster.agents.find((agent) => agent.kind === "jev" && agent.free && agent.available);
if (calibrated && engine.scale === 1) {
  console.log("calibrated model");
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
  check(deflected.x > 5, `cursor right deflects the stick right (${deflected.x})`);
  check(deflected.y > 3, `cursor forward pushes the stick forward (${deflected.y})`);
}
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
// Only the box above it was ever measured, so a version shipped with the whole
// compass rose translated half a screen right and every assertion still passed.
check(
  Math.abs(headingTicks.x - viewport.w / 2) < viewport.w * 0.06 && headingTicks.w > 120,
  `heading scale is centred under its box and on screen (${Math.round(headingTicks.x)}, ${Math.round(headingTicks.w)} px)`,
);
check(
  throttle.x < viewport.w * 0.3 && throttle.y > viewport.y * 0.7,
  `throttle sits bottom-left (${Math.round(throttle.x)}, ${Math.round(throttle.y)})`,
);
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

console.log("cameras");
type Shot = { camera: number[]; subjectW: number; standoffM: number; fov: number };
const cameraIn = async (view: string): Promise<Shot> => {
  await page.selectOption("#view", view);
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: `${OUT}/view-${view}-${engine.name}.png` });
  return (await page.evaluate(SHOT_PROBE)) as Shot;
};
const apart = (a: Shot, b: Shot): number =>
  Math.hypot(a.camera[0]! - b.camera[0]!, a.camera[1]! - b.camera[1]!, a.camera[2]! - b.camera[2]!);

const track = await cameraIn("track");
const trackBandit = (await page.evaluate(BANDIT_PROBE)) as {
  shown: boolean;
  x: number | null;
  viewW: number;
};
check(
  trackBandit.shown && Math.abs(trackBandit.x! - trackBandit.viewW / 2) < trackBandit.viewW * 0.1,
  `target track puts the bandit on the centre line (${Math.round(trackBandit.x ?? -1)} of ${trackBandit.viewW})`,
);

const arena = await cameraIn("arena");
check(apart(arena, track) > 100, `arena stands somewhere else entirely (${apart(arena, track).toFixed(0)} m)`);
check(arena.subjectW > 0.002, `arena keeps the aircraft bigger than a pixel (${(arena.subjectW * 100).toFixed(1)}% of the width)`);

const chase = await cameraIn("chase");
check(apart(chase, arena) > 50, `chase stands somewhere else again (${apart(chase, arena).toFixed(0)} m)`);
check(
  chase.standoffM > 30 && chase.standoffM < 90,
  `chase holds its distance while the jet is moving (${chase.standoffM.toFixed(0)} m)`,
);

/**
 * The wheel zooms in every view, and each view decides what that means.
 *
 * It used to be read only while flying with the mouse, and the orbit controls
 * -- which handled it otherwise -- are switched off wherever the camera places
 * itself. So it did nothing in four views out of five.
 */
/**
 * Paused, because the track camera's stand-off grows with the separation.
 *
 * It stood 88 m off, the wheel halved its framing, and by the time the second
 * sample was taken the two aircraft had flown far enough apart that the view's
 * natural distance had nearly doubled -- so the measurement said 88 m to 82 m
 * and called a working zoom broken. The camera keeps following while the
 * simulation is stopped, so nothing else about the test changes.
 */
if ((await page.getAttribute("#app", "data-sim-status")) === "running") await page.click("#pause");
await page.waitForTimeout(600);

const zoomed = async (view: string): Promise<{ before: Shot; after: Shot }> => {
  await page.selectOption("#view", view);
  await page.waitForTimeout(1_800);
  const before = (await page.evaluate(SHOT_PROBE)) as Shot;
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1_200);
  return { before, after: (await page.evaluate(SHOT_PROBE)) as Shot };
};

for (const view of ["free", "chase", "track", "arena"]) {
  const { before, after } = await zoomed(view);
  check(
    after.standoffM < before.standoffM * 0.9,
    `the wheel pulls the ${view} view in (${before.standoffM.toFixed(0)} m to ${after.standoffM.toFixed(0)} m)`,
  );
}

// From the cockpit the eye cannot move, so the wheel narrows the field of view
// instead -- which is also the only measurement of it from outside.
const cockpitZoom = await zoomed("cockpit");
check(
  cockpitZoom.after.fov < cockpitZoom.before.fov * 0.9,
  `the wheel narrows the cockpit's field of view (${cockpitZoom.before.fov.toFixed(0)}° to ${cockpitZoom.after.fov.toFixed(0)}°)`,
);

await page.selectOption("#view", "free");
if ((await page.getAttribute("#app", "data-sim-status")) === "paused") await page.click("#pause");
await page.waitForTimeout(1_500);

/**
 * Nothing sits on top of anything else, at any window a person might have.
 *
 * Only the widescreen case was measured, and the furniture moves: the control
 * bar grows rows as it wraps, its offset from the bottom changes at 900px, and
 * the recording notice spans the width below 560px. Each of those broke the
 * details panel's clearance in turn, and none of them showed up at 1600x900.
 */
const RECTANGLES = `(() => {
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
    box('recording notice', '.recording'),
  ].filter(Boolean);
})()`;

type Rect = { name: string; l: number; t: number; r: number; b: number };
const overlapsIn = async (label: string): Promise<void> => {
  const rectangles = (await page.evaluate(RECTANGLES)) as Rect[];
  const hits: string[] = [];
  for (let i = 0; i < rectangles.length; i += 1) {
    for (let j = i + 1; j < rectangles.length; j += 1) {
      const a = rectangles[i]!;
      const b = rectangles[j]!;
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) hits.push(`${a.name} on ${b.name}`);
    }
  }
  check(hits.length === 0, `${label}: nothing overlaps${hits.length ? ` (${hits.join(", ")})` : ""}`);
};

await overlapsIn("widescreen");

const widescreen = page.viewportSize()!;
for (const [width, height] of [
  [1280, 720],
  [900, 650],
  [500, 800],
] as const) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(1_400);
  await overlapsIn(`${width}x${height}`);
}
await page.setViewportSize(widescreen);
await page.waitForTimeout(1_200);

console.log("tactical overlay");
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
check(sawArrowOrBox, "bandit is always indicated, on screen or off");
if (!sawTarget) console.log(`  note  ${engineLabel}bandit stayed off screen during sampling`);
check(
  (await page.locator(".shoot-cue").count()) === 1,
  "shoot cue exists to be shown when a burst would connect",
);
await page.screenshot({ path: `${OUT}/overlay-${engine.name}.png` });

console.log("leaderboard");
await page.getByRole("link", { name: "Leaderboard", exact: true }).click();
const leaderboardRows = await countRows(page);
check(leaderboardRows > 0, `leaderboard shows ${leaderboardRows} agents`);
await page.screenshot({ path: `${OUT}/leaderboard-${engine.name}.png` });

console.log("match history and replay");
await page.getByRole("link", { name: "Replays", exact: true }).click();
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
if (decisions.served > 0) {
  const rate = decisions.refused / decisions.served;
  check(
    rate < 0.1,
    `the model answered nearly every decision (${decisions.served - decisions.refused} of ${decisions.served})`,
  );
}
await checkCanvasFitsWindow(page);

await browser.close();
}

console.log(`\nScreenshots in ${OUT}/`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll UI checks passed.");
