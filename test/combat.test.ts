import { describe, expect, it } from "vitest";
import { GUN } from "../src/sim/config";
import { fireGun } from "../src/sim/gun";
import { Random } from "../src/sim/random";
import { createNeutralMerge, neutralMerge, scenarioSet } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { BasicPursuitAgent, EnergyFighterAgent } from "../src/agents/baselines";

const DT = 1 / 120;

function shooter() {
  const state = createNeutralMerge(neutralMerge);
  return { state, aircraft: state.aircraft[0]!, rng: new Random(7), nextId: (() => { let id = 1; return () => id++; })() };
}

describe("trigger response", () => {
  it("puts rounds out almost immediately rather than gating on spin-up", () => {
    const { state, aircraft, rng, nextId } = shooter();
    aircraft.controls.fire = true;
    let firstRoundAt = Infinity;
    for (let i = 0; i < 1 / DT; i += 1) {
      const before = state.projectiles.length;
      fireGun(state, aircraft, DT, rng, nextId);
      if (state.projectiles.length > before) {
        firstRoundAt = Math.min(firstRoundAt, i * DT);
        break;
      }
    }
    // A tenth of a second of dead trigger is the most a player will forgive.
    expect(firstRoundAt).toBeLessThan(0.1);
  });

  it("ramps up to the rated rate as the rotor spins", () => {
    const { state, aircraft, rng, nextId } = shooter();
    aircraft.controls.fire = true;
    const count = (seconds: number) => {
      const before = state.projectiles.length;
      for (let i = 0; i < seconds / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
      return state.projectiles.length - before;
    };
    const firstQuarter = count(0.25);
    count(0.5);
    const settled = count(0.25);
    expect(firstQuarter).toBeGreaterThan(0);
    expect(firstQuarter).toBeLessThan(settled);
    // Settled cadence is the rated rate.
    expect(settled).toBeGreaterThanOrEqual(GUN.ratePerSecond * 0.25 - 1);
  });

  it("still fires when the trigger is tapped in short bursts", () => {
    const { state, aircraft, rng, nextId } = shooter();
    for (let burst = 0; burst < 4; burst += 1) {
      aircraft.controls.fire = true;
      for (let i = 0; i < 0.1 / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
      aircraft.controls.fire = false;
      for (let i = 0; i < 0.3 / DT; i += 1) fireGun(state, aircraft, DT, rng, nextId);
    }
    // The rotor coasts between taps, so every tap produces rounds.
    expect(GUN.ammunition - aircraft.ammo).toBeGreaterThan(20);
  });
});

describe("standing orders", () => {
  it("keeps flying a tactical command between decisions", async () => {
    // One decision per second: if the command were resolved once and held, the
    // stick would be frozen for a full second at a time and would change on
    // only about one tick in a hundred and twenty.
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 8 }, { decisionIntervalS: 1 });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));

    const blue = sim.state.aircraft[0]!;
    let ticks = 0;
    let changes = 0;
    let previous = "";
    await sim.runHeadless(() => {
      ticks += 1;
      const current = `${blue.controls.pitch.toFixed(6)}/${blue.controls.roll.toFixed(6)}/${blue.controls.yaw.toFixed(6)}`;
      if (current !== previous) changes += 1;
      previous = current;
    });

    expect(ticks).toBeGreaterThan(500);
    // Eight decisions over eight seconds; the stick must move far more often.
    expect(changes).toBeGreaterThan(ticks * 0.5);
  }, 30_000);

  it("hands the trigger back to a raw-schema agent", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 1 }, { decisionIntervalS: 0.25 });
    sim.attachAgent("blue-1", {
      id: "raw",
      info: { name: "raw", provider: "test", model: "raw", policyVersion: "1", schema: "raw" },
      decide: async () => ({
        action: { schema: "raw", controls: { pitch: 0, roll: 0, yaw: 0, throttle: 1, fire: true } } as const,
      }),
    });
    await sim.runHeadless();
    // A raw agent firing into empty sky still expends ammunition; the autopilot
    // does not get to second-guess it.
    expect(sim.state.aircraft[0]!.ammo).toBeLessThan(GUN.ammunition);
  }, 30_000);
});

describe("the energy fighter", () => {
  it("holds a speed near corner instead of spiralling down or running away", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, maxTime: 90 }, { recordDecisions: false });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
    sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));

    const blue = sim.state.aircraft[0]!;
    const ratios: number[] = [];
    let ticks = 0;
    await sim.runHeadless(() => {
      ticks += 1;
      if (ticks % 120 !== 0 || !blue.alive) return;
      const corner = Math.sqrt(
        (2 * 9 * blue.massKg * 9.80665) / (1.225 * Math.exp(-blue.position.y / 8_500) * 27.87 * 1.9),
      );
      ratios.push(blue.velocity.length() / corner);
    });

    const late = ratios.slice(Math.floor(ratios.length / 3));
    const mean = late.reduce((sum, value) => sum + value, 0) / Math.max(late.length, 1);
    // Between about corner and half again: fast enough to turn, not so fast
    // that the turn radius makes conversion impossible.
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.75);
  }, 60_000);

  it("beats the naive baseline decisively and shoots far better", async () => {
    let energyWins = 0;
    let basicWins = 0;
    let energyRounds = 0;
    let energyHits = 0;
    let basicRounds = 0;
    let basicHits = 0;

    for (const scenario of scenarioSet(6, { ...neutralMerge, maxTime: 180 })) {
      // Both sides of every scenario, so a side advantage cannot decide it.
      for (const energyIsBlue of [true, false]) {
        const sim = new DogfightSimulation(scenario, { recordDecisions: false });
        sim.attachAgent("blue-1", energyIsBlue ? new EnergyFighterAgent("blue-1") : new BasicPursuitAgent("blue-1"));
        sim.attachAgent("red-1", energyIsBlue ? new BasicPursuitAgent("red-1") : new EnergyFighterAgent("red-1"));
        await sim.runHeadless();

        const summary = sim.summary();
        const energyId = energyIsBlue ? "blue-1" : "red-1";
        const energy = summary.aircraft.find((aircraft) => aircraft.id === energyId)!;
        const basic = summary.aircraft.find((aircraft) => aircraft.id !== energyId)!;
        energyRounds += energy.roundsFired;
        energyHits += energy.hitsScored;
        basicRounds += basic.roundsFired;
        basicHits += basic.hitsScored;
        if (sim.state.winnerId === energyId) energyWins += 1;
        else if (sim.state.winnerId) basicWins += 1;
      }
    }

    expect(energyWins).toBeGreaterThan(basicWins * 2);
    // And it does not merely survive: it lands hits at a much better rate.
    const energyAccuracy = energyRounds ? energyHits / energyRounds : 0;
    const basicAccuracy = basicRounds ? basicHits / basicRounds : 0;
    expect(energyHits).toBeGreaterThan(0);
    expect(energyAccuracy).toBeGreaterThan(basicAccuracy);
  }, 300_000);
});
