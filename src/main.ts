import "./style.css";
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
    <div class="brand"><span class="mark">DB</span><div>DOGFIGHT <b>BENCH</b></div></div>
    <div class="status"><span class="live-dot"></span><span id="run-status">LIVE</span><strong id="clock">00:00.0</strong></div>
  </header>
  <div class="orbit-help">DRAG TO ORBIT · SCROLL TO ZOOM</div>
  <footer class="controls">
    <label>BLUE PILOT <select id="blue-pilot"><option value="human">HUMAN</option><option value="basic">BASELINE AI</option></select></label>
    <button id="follow">FOLLOW RED</button>
    <button id="pause">PAUSE</button>
    <button id="speed">1× REALTIME</button>
    <button id="restart">RESTART MATCH</button>
    <button id="replay">SAVE REPLAY</button>
  </footer>
  <div class="flight-strip"><span id="flight-data">BLUE · 0 KT · 0 FT · 511 ROUNDS</span><span id="event">MERGE INITIALIZED</span></div>
  <div class="keymap">W/S PITCH · A/D ROLL · Q/E RUDDER · R/F THROTTLE · SPACE FIRE</div>
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
  text("clock", `${String(Math.floor(simulation.state.time / 60)).padStart(2, "0")}:${(simulation.state.time % 60).toFixed(1).padStart(4, "0")}`);
  const followed = followRed ? red : blue;
  text("flight-data", `${followed.team.toUpperCase()} · ${Math.round(followed.velocity.length() * 1.94384)} KT · ${Math.round(followed.position.y * 3.28084).toLocaleString()} FT · ${followed.ammo} ROUNDS`);
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
