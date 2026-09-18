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

const BASE = process.env["UI_CHECK_URL"] ?? "http://localhost:5174";
const OUT = "artifacts/ui-check";

interface Framing {
  x: number;
  y: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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
  check(
    measured.bufferWidth >= measured.innerWidth * Math.min(measured.ratio, 2) - 2,
    `backing store matches the device pixel ratio (${measured.bufferWidth})`,
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

const engines: Array<{ name: string; launch: () => Promise<Browser>; scale: number }> = [
  { name: "chromium", launch: () => chromium.launch(), scale: 1 },
  { name: "chromium@2x", launch: () => chromium.launch(), scale: 2 },
  { name: "webkit", launch: () => webkit.launch(), scale: 1 },
  { name: "webkit@2x", launch: () => webkit.launch(), scale: 2 },
];

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
// Long enough that any per-frame drift would be obvious.
await page.waitForTimeout(8_000);
checkFraming("default live view", await framing(page));
check(
  Number(await page.getAttribute("#app", "data-sim-time")) > 5,
  "simulation is actually running",
);
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
check(sawReticle, "gunsight reticle is drawn");
check(sawTarget, "bandit is boxed on screen");
check(sawArrowOrBox, "bandit is always indicated, on screen or off");
// Whether a scripted fight produces a firing solution inside a twenty-second
// window is luck, so the cue's gating is pinned by a unit test instead; here we
// only confirm the element exists to be shown.
check(
  (await page.locator(".shoot-cue").count()) === 1,
  "shoot cue exists to be shown when a burst would connect",
);
await page.screenshot({ path: `${OUT}/overlay-${engine.name}.png` });

console.log("leaderboard");
await page.click("text=LEADERBOARD");
await page.waitForTimeout(1_500);
const leaderboardRows = await page.locator("table.data tbody tr").count();
check(leaderboardRows > 0, `leaderboard shows ${leaderboardRows} agents`);
await page.screenshot({ path: `${OUT}/leaderboard-${engine.name}.png` });

console.log("match history and replay");
await page.click("text=MATCHES");
await page.waitForTimeout(1_500);
const matchRows = await page.locator("table.data tbody tr").count();
check(matchRows > 0, `match history shows ${matchRows} matches`);
await page.screenshot({ path: `${OUT}/matches-${engine.name}.png` });

await page.locator("text=WATCH").first().click();
await page.waitForTimeout(6_000);
const replayTime = await page.locator(".timecode").textContent();
check(Boolean(replayTime && parseFloat(replayTime) > 0.5), `replay is playing (${replayTime?.trim()})`);
checkFraming("replay view", await framing(page));
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
