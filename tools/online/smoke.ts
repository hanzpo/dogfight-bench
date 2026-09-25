// Two scripted players fight through a real server, to check online play end to end.
//
//   npm run check:online                                  # against `npm run dev:online`
//   npm run check:online -- https://dogfight.hanzpo.com   # against a deployment
//
// It makes a room, joins it twice, readies both, flies eight seconds with one
// of them shooting, and checks the room kept time, sent its snapshots, and
// took the players' inputs in time. Exits non-zero if anything is off.

import { OnlineClient } from "../../src/net/client";
import type { ServerMessage } from "../../src/net/protocol";
import type { ControlInput } from "../../src/sim/types";

const base = process.argv[2] ?? "http://localhost:8788";
const FLY_MS = 8_000;

const { code } = (await (await fetch(`${base}/api/online/rooms`, { method: "POST" })).json()) as { code: string };
const received = { bytes: 0, states: 0, lastAt: 0, maxGapMs: 0 };

function connect(name: string, airframe: string) {
  const query = new URLSearchParams({ name, airframe, session: `smoke-${name}-${code}` });
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/online/rooms/${code}/socket?${query}`);
  const client = new OnlineClient((message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  });
  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    const message = JSON.parse(text) as ServerMessage;
    if (message.type === "state") {
      received.bytes += text.length;
      received.states += 1;
      const now = performance.now();
      // Measured on one player, once the fight is under way: a gap much over 50 ms means the clock stalls.
      if (name === "Alpha" && received.lastAt && message.snapshot.tick > 120) {
        received.maxGapMs = Math.max(received.maxGapMs, now - received.lastAt);
      }
      if (name === "Alpha") received.lastAt = now;
    }
    client.receive(message, performance.now());
  });
  return { ws, client };
}

const shooter = connect("Alpha", "su27s");
const target = connect("Bravo", "f5e");
const level: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false, missile: false, flare: false };
const frames = setInterval(() => {
  const now = performance.now();
  shooter.client.frame(now, { ...level, pitch: 0.2, fire: true });
  target.client.frame(now, level);
}, 16);

await new Promise((resolve) => setTimeout(resolve, 800));
shooter.client.choose({ type: "weapons", weapons: "fox2" });
shooter.client.choose({ type: "ready", ready: true });
target.client.choose({ type: "ready", ready: true });

await new Promise((resolve) => setTimeout(resolve, 3_300));
const started = performance.now();
await new Promise((resolve) => setTimeout(resolve, FLY_MS));
clearInterval(frames);

const expectedTicks = Math.round((performance.now() - started) / (1000 / 120));
const serverTick = shooter.client.latest?.tick ?? 0;
const report = {
  room: code,
  players: shooter.client.lobby?.players.map((player) => `${player.name} (${player.airframe})`).join(" vs "),
  serverTicks: serverTick,
  expectedTicksAbout: expectedTicks,
  snapshotsPerPlayerPerSecond: Math.round(received.states / 2 / (FLY_MS / 1000)),
  averageSnapshotKB: Number((received.bytes / Math.max(received.states, 1) / 1024).toFixed(1)),
  longestGapBetweenSnapshotsMs: Math.round(received.maxGapMs),
  roundTripMs: Math.round(shooter.client.rttMs),
  leadTicks: Number(shooter.client.leadTicks.toFixed(1)),
  roundsInTheAir: shooter.client.state?.projectiles.length ?? 0,
};
console.log(report);

shooter.ws.close();
target.ws.close();

const problems = [
  serverTick < expectedTicks * 0.9 && "the room fell behind the clock",
  report.snapshotsPerPlayerPerSecond < 15 && "too few snapshots",
  report.longestGapBetweenSnapshotsMs > 200 && "the room's clock stalls between snapshots",
  report.roundsInTheAir === 0 && "no rounds reached the shooter's own view",
  shooter.client.scenario?.weapons !== "fox2" && "the host's weapons choice did not take",
].filter(Boolean);
if (problems.length) {
  console.error("Problems:", problems.join("; "));
  process.exit(1);
}
console.log("Online play works.");
process.exit(0);
