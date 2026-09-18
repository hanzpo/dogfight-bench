import "./style.css";
import { SCRIPTED_INFO } from "./agents/agent";
import { EnergyFighterAgent } from "./agents/baselines";
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
    <label>SPEED <select id="speed"><option value="1">1× REALTIME</option><option value="4">4× ACCELERATED</option><option value="16">16× ACCELERATED</option></select></label>
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
    simulation.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
  }
  simulation.attachAgent("red-1", new EnergyFighterAgent("red-1"));
  const bluePilot = (document.querySelector("#blue-pilot") as HTMLSelectElement).value;
  recorder = new ReplayRecorder(neutralMerge, {
    "blue-1": bluePilot === "basic" ? SCRIPTED_INFO("energy-fighter") : SCRIPTED_INFO("human", "raw"),
    "red-1": SCRIPTED_INFO("energy-fighter"),
  });
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
document.querySelector("#speed")!.addEventListener("change", (event) => {
  timeScale = Number((event.target as HTMLSelectElement).value);
});
document.querySelector("#restart")!.addEventListener("click", reset);
document.querySelector("#blue-pilot")!.addEventListener("change", reset);
document.querySelector("#follow")!.addEventListener("click", () => {
  followRed = !followRed;
  viewer.setFollow(followRed ? "red-1" : "blue-1");
  text("follow", followRed ? "FOLLOW BLUE" : "FOLLOW RED");
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
  (document.querySelector("#speed") as HTMLSelectElement).value = String(timeScale);
  text("pause", paused ? "RESUME" : "PAUSE");
  app.dataset.simStatus = simulation.state.finished ? "complete" : paused ? "paused" : "running";
  app.dataset.simTime = simulation.state.time.toFixed(3);
  app.dataset.follow = followRed ? "red-1" : "blue-1";
  app.dataset.timeScale = String(timeScale);
  app.dataset.bluePilot = (document.querySelector("#blue-pilot") as HTMLSelectElement).value;
  app.dataset.camera = viewer.camera.position.toArray().map((value) => value.toFixed(3)).join(",");
  const framing = viewer.getFollowFraming();
  if (framing) {
    app.dataset.subjectScreenX = framing.x.toFixed(4);
    app.dataset.subjectScreenY = framing.y.toFixed(4);
    app.dataset.subjectMinX = framing.minX.toFixed(4);
    app.dataset.subjectMaxX = framing.maxX.toFixed(4);
    app.dataset.subjectMinY = framing.minY.toFixed(4);
    app.dataset.subjectMaxY = framing.maxY.toFixed(4);
  }
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
      if (simulation.state.finished) recorder.finish(simulation.decisions, simulation.summary());
      accumulator -= neutralMerge.fixedDt;
    }
  }
  updateHud();
  viewer.render(simulation.state);
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);
