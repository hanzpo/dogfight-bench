import { describe, expect, it } from "vitest";
import { SCRIPTED_INFO } from "../src/agents/agent";
import { EnergyFighterAgent } from "../src/agents/baselines";
import { REPLAY_VERSION, ReplayAgent, ReplayRecorder, parseReplay } from "../src/sim/replay";
import { neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";

async function recordMatch(maxTime = 25) {
  const scenario = { ...neutralMerge, maxTime };
  const sim = new DogfightSimulation(scenario);
  sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
  sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));
  const recorder = new ReplayRecorder(scenario, {
    "blue-1": SCRIPTED_INFO("energy-fighter"),
    "red-1": SCRIPTED_INFO("energy-fighter"),
  });
  await sim.runHeadless((state) => recorder.capture(state));
  recorder.finish(sim.decisions, sim.summary());
  return { sim, recorder, scenario };
}

describe("replays", () => {
  it("records frames, events, decisions and the result", async () => {
    const { sim, recorder } = await recordMatch();
    const replay = recorder.replay;
    expect(replay.version).toBe(REPLAY_VERSION);
    expect(replay.frames.length).toBeGreaterThan(50);
    expect(replay.decisions.length).toBeGreaterThan(10);
    expect(replay.events.length).toBeGreaterThan(0);
    expect(replay.summary?.scenarioId).toBe(sim.config.id);
    expect(replay.agents["blue-1"]?.name).toBe("energy-fighter");

    const frame = replay.frames[10]!;
    expect(frame.aircraft).toHaveLength(2);
    expect(frame.aircraft[0]!.q).toHaveLength(4);
    expect(frame.t).toBeGreaterThan(0);
    expect(frame.aircraft[0]!.s).toHaveLength(7);
    expect(frame.aircraft[0]!.s[2]).toBeGreaterThan(0);
  });

  it("round-trips through JSON and rejects a foreign file", async () => {
    const { recorder } = await recordMatch(5);
    const parsed = parseReplay(recorder.toJSON());
    expect(parsed.frames.length).toBe(recorder.replay.frames.length);
    expect(() => parseReplay(JSON.stringify({ format: "something-else" }))).toThrow();
    expect(() => parseReplay(JSON.stringify({ format: "dogfight-replay", version: 1 }))).toThrow(/version/);
  });

  it("reproduces a match exactly from the decision log alone", async () => {
    const { sim, recorder, scenario } = await recordMatch(25);
    const replay = parseReplay(recorder.toJSON());

    const reproduction = new DogfightSimulation(scenario);
    reproduction.attachAgent("blue-1", new ReplayAgent("blue-1", replay, "blue-1"));
    reproduction.attachAgent("red-1", new ReplayAgent("red-1", replay, "red-1"));
    await reproduction.runHeadless();

    expect(reproduction.state.time).toBeCloseTo(sim.state.time, 6);
    expect(reproduction.state.winnerId).toBe(sim.state.winnerId);
    expect(reproduction.state.finishReason).toBe(sim.state.finishReason);
    for (const [index, aircraft] of reproduction.state.aircraft.entries()) {
      const original = sim.state.aircraft[index]!;
      expect(aircraft.position.distanceTo(original.position)).toBeLessThan(1e-6);
      expect(aircraft.ammo).toBe(original.ammo);
      expect(aircraft.damage.integrity).toBeCloseTo(original.damage.integrity, 9);
    }
  });
});

describe("replayed tracers", () => {
  it("records both ends of every tracer, so playback never has to guess", async () => {
    const scenario = { ...neutralMerge, maxTime: 6 };
    const sim = new DogfightSimulation(scenario);
    const recorder = new ReplayRecorder(scenario, {
      "blue-1": SCRIPTED_INFO("gunner"),
      "red-1": SCRIPTED_INFO("target"),
    });
    await sim.runHeadless((state) => {
      state.aircraft[0]!.controls.fire = true;
      recorder.capture(state);
    });

    const withTracers = recorder.replay.frames.filter((frame) => (frame.projectiles?.length ?? 0) > 0);
    expect(withTracers.length).toBeGreaterThan(5);

    for (const frame of withTracers) {
      for (const segment of frame.projectiles!) {
        expect(segment).toHaveLength(6);
        const [ax, ay, az, bx, by, bz] = segment;
        const length = Math.hypot(bx! - ax!, by! - ay!, bz! - az!);
        expect(length).toBeLessThan(40);
        expect(Math.abs(by! - ay!)).toBeLessThan(length * 0.9);
      }
    }
  }, 60_000);
});
