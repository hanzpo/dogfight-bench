import "./style.css";
import { Vector3 } from "three";
import { BasicPursuitAgent } from "./agents/basic-agent";
import { ReplayRecorder } from "./sim/replay";
import { neutralMerge } from "./sim/scenario";
import { DogfightSimulation } from "./sim/simulation";
import type { ControlInput } from "./sim/types";
import { DogfightViewer } from "./viewer";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="viewport"></div>
  <header class="topbar">
    <div class="brand"><span class="mark">DB</span><div>DOGFIGHT <b>BENCH</b><small>NEUTRAL MERGE / GUNS ONLY</small></div></div>
    <div class="status"><span class="live-dot"></span><span id="run-status">LIVE</span><strong id="clock">00:00.0</strong></div>
  </header>
  <aside class="panel left-panel">
    <div class="eyebrow blue">BLUE / OWN SHIP</div>
    <div class="big-number"><span id="blue-speed">0</span><small>KTS</small></div>
    <div class="metric-row"><span>ALT</span><b id="blue-alt">0 FT</b></div>
    <div class="metric-row"><span>MACH</span><b id="blue-mach">0.00</b></div>
    <div class="metric-row"><span>AOA</span><b id="blue-aoa">0.0°</b></div>
    <div class="metric-row"><span>LOAD</span><b id="blue-g">1.0 G</b></div>
    <div class="metric-row"><span>20MM</span><b id="blue-ammo">511</b></div>
    <div class="divider"></div>
    <label>BLUE PILOT<select id="blue-pilot"><option value="human">Human</option><option value="basic">Baseline AI</option></select></label>
    <div class="keymap">W/S pitch · A/D roll<br>Q/E rudder · R/F throttle<br>SPACE fire</div>
  </aside>
  <aside class="panel right-panel">
    <div class="eyebrow red">RED / BANDIT</div>
    <div class="big-number"><span id="range">0.0</span><small>NM</small></div>
    <div class="metric-row"><span>CLOSURE</span><b id="closure">0 KTS</b></div>
    <div class="metric-row"><span>ASPECT</span><b id="aspect">0°</b></div>
    <div class="metric-row"><span>20MM</span><b id="red-ammo">511</b></div>
    <div class="divider"></div>
    <label>RED PILOT<select id="red-pilot"><option value="basic">Baseline AI</option></select></label>
    <button id="follow">FOLLOW RED</button>
  </aside>
  <div class="reticle"><i></i><span></span><i></i></div>
  <footer class="controls">
    <button id="pause">PAUSE</button>
    <button id="speed">1× REALTIME</button>
    <button id="restart">RESTART MATCH</button>
    <button id="replay">SAVE REPLAY</button>
    <span id="event">MERGE INITIALIZED</span>
  </footer>
`;

const viewport = document.querySelector<HTMLElement>("#viewport")!;
const viewer = new DogfightViewer(viewport);
await viewer.loadAircraft();

let simulation: DogfightSimulation;
let recorder: ReplayRecorder;
let paused = false;
let timeScale = 1;
let accumulator = 0;
let lastFrame = performance.now();
let followRed = false;
const keys = new Set<string>();
const human: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false };

function reset(): void {
  simulation = new DogfightSimulation(neutralMerge, 0.25);
  if ((document.querySelector("#blue-pilot") as HTMLSelectElement).value === "basic") {
    simulation.attachAgent("blue-1", new BasicPursuitAgent("baseline-blue"));
  }
  simulation.attachAgent("red-1", new BasicPursuitAgent("baseline-red"));
  recorder = new ReplayRecorder(neutralMerge, { "blue-1": "human/baseline", "red-1": "baseline-v1" });
  accumulator = 0;
  paused = false;
}

function humanControls(): void {
  const axis = (positive: string, negative: string) => (keys.has(positive) ? 1 : 0) - (keys.has(negative) ? 1 : 0);
  human.pitch = axis("KeyW", "KeyS");
  human.roll = axis("KeyD", "KeyA");
  human.yaw = axis("KeyE", "KeyQ");
  human.throttle = Math.max(0, Math.min(1, human.throttle + axis("KeyR", "KeyF") * 0.006));
  human.fire = keys.has("Space");
  if ((document.querySelector("#blue-pilot") as HTMLSelectElement).value === "human") {
    simulation.setHumanControls("blue-1", { ...human });
  }
}

addEventListener("keydown", (event) => {
  if (["Space", "ArrowUp", "ArrowDown"].includes(event.code)) event.preventDefault();
  keys.add(event.code);
});
addEventListener("keyup", (event) => keys.delete(event.code));

document.querySelector("#pause")!.addEventListener("click", () => { paused = !paused; });
document.querySelector("#speed")!.addEventListener("click", () => {
  timeScale = timeScale === 1 ? 4 : timeScale === 4 ? 16 : 1;
});
document.querySelector("#restart")!.addEventListener("click", reset);
document.querySelector("#blue-pilot")!.addEventListener("change", reset);
document.querySelector("#follow")!.addEventListener("click", () => {
  followRed = !followRed;
  viewer.setFollow(followRed ? "red-1" : "blue-1");
});
document.querySelector("#replay")!.addEventListener("click", () => {
  const url = URL.createObjectURL(recorder.toBlob());
  const a = document.createElement("a");
  a.href = url; a.download = `dogfight-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
});

function text(id: string, value: string): void { document.querySelector(`#${id}`)!.textContent = value; }

function updateHud(): void {
  const [blue, red] = simulation.state.aircraft;
  if (!blue || !red) return;
  const delta = red.position.clone().sub(blue.position);
  const los = delta.clone().normalize();
  const closure = -red.velocity.clone().sub(blue.velocity).dot(los);
  const redForward = new Vector3(0, 0, 1);
  // Avoid relying on a derived telemetry object just for HUD rendering.
  redForward.applyQuaternion(red.orientation);
  const aspect = Math.acos(Math.max(-1, Math.min(1, redForward.dot(los)))) * 180 / Math.PI;
  text("clock", `${String(Math.floor(simulation.state.time / 60)).padStart(2, "0")}:${(simulation.state.time % 60).toFixed(1).padStart(4, "0")}`);
  text("blue-speed", Math.round(blue.velocity.length() * 1.94384).toString());
  text("blue-alt", `${Math.round(blue.position.y * 3.28084).toLocaleString()} FT`);
  text("blue-mach", (blue.velocity.length() / 326).toFixed(2));
  text("blue-aoa", `${(blue.aoaRad * 180 / Math.PI).toFixed(1)}°`);
  text("blue-g", `${blue.loadFactor.toFixed(1)} G`);
  text("blue-ammo", blue.ammo.toString());
  text("red-ammo", red.ammo.toString());
  text("range", (delta.length() / 1852).toFixed(1));
  text("closure", `${Math.round(closure * 1.94384)} KTS`);
  text("aspect", `${Math.round(aspect)}°`);
  text("run-status", simulation.state.finished ? "COMPLETE" : paused ? "PAUSED" : "LIVE");
  text("speed", `${timeScale}× ${timeScale === 1 ? "REALTIME" : "ACCELERATED"}`);
  text("pause", paused ? "RESUME" : "PAUSE");
  const latest = simulation.state.events.at(-1);
  text("event", simulation.state.finished
    ? `${simulation.state.winnerId?.toUpperCase() ?? "DRAW"} · ${simulation.state.finishReason}`
    : latest ? `${latest.type.toUpperCase()} ${latest.actorId ?? ""}` : "MERGE INITIALIZED");
}

function frame(now: number): void {
  const wallDt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (!paused && !simulation.state.finished) {
    accumulator += wallDt * timeScale;
    humanControls();
    let safety = 0;
    while (accumulator >= neutralMerge.fixedDt && safety++ < 500) {
      simulation.step();
      recorder.capture(simulation.state);
      accumulator -= neutralMerge.fixedDt;
    }
  }
  updateHud();
  viewer.render(simulation.state);
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);
