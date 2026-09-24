import { describe, expect, it } from "vitest";
import { fox2Merge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import type { ControlInput, SimEvent } from "../src/sim/types";

/** Both jets flown by a fixed script: a hard turn, the gun, a missile and flares, all on a timetable. */
function script(tick: number, seat: number): ControlInput {
  return {
    pitch: seat === 0 ? 0.6 : 0.4,
    roll: Math.sin(tick / 90 + seat) * 0.5,
    yaw: 0,
    throttle: 0.9,
    fire: tick > 60 && tick % 240 < 90,
    missile: tick % 600 > 590,
    flare: seat === 1 && tick % 300 < 4,
  };
}

function fly(sim: DogfightSimulation, ticks: number): void {
  for (let n = 0; n < ticks && !sim.state.finished; n += 1) {
    sim.setHumanControls("blue-1", script(sim.state.tick, 0));
    sim.setHumanControls("red-1", script(sim.state.tick, 1));
    sim.step();
  }
}

// A close, nose-to-nose start, so that there is shooting to carry across.
const scenario = { ...fox2Merge, seed: 7, startSeparationM: 1_600, airframes: { "blue-1": "su27s" as const, "red-1": "f5e" as const } };

function copyAt(original: DogfightSimulation): DogfightSimulation {
  // Through JSON, the way it travels.
  const snapshot = JSON.parse(JSON.stringify(original.snapshot()));
  const events = JSON.parse(JSON.stringify(original.state.events)) as SimEvent[];
  const copy = new DogfightSimulation(scenario, { recordDecisions: false });
  copy.restore(snapshot, events);
  return copy;
}

describe("a simulation snapshot", () => {
  it("carries on as the original from a quiet moment, to within a millimetre", () => {
    const original = new DogfightSimulation(scenario, { recordDecisions: false });
    fly(original, 30);
    expect(original.state.projectiles).toHaveLength(0);
    const copy = copyAt(original);
    fly(original, 1_200);
    fly(copy, 1_200);
    expect(copy.state.tick).toBe(original.state.tick);
    // Numbers travel to nine figures: a state the snapshot forgot would show as metres, not microns.
    for (const [index, aircraft] of original.state.aircraft.entries()) {
      const twin = copy.state.aircraft[index]!;
      expect(twin.position.distanceTo(aircraft.position)).toBeLessThan(0.001);
      expect(twin.orientation.angleTo(aircraft.orientation)).toBeLessThan(1e-5);
      expect(twin.damage.hitsTaken).toBe(aircraft.damage.hitsTaken);
      expect(twin.stores).toEqual(aircraft.stores);
    }
    expect(copy.state.events.map((event) => event.type)).toEqual(original.state.events.map((event) => event.type));
  });

  it("carries on as the original with rounds, missiles and flares in the air", () => {
    const original = new DogfightSimulation(scenario, { recordDecisions: false });
    fly(original, 620);
    expect(original.state.projectiles.length + original.state.missiles.length + original.state.flares.length).toBeGreaterThan(0);
    const copy = copyAt(original);
    expect(copy.state.projectiles).toHaveLength(original.state.projectiles.length);
    fly(original, 600);
    fly(copy, 600);
    // Rounds travel as 32-bit floats, so a round may land a hair differently; the jets fly the same.
    for (const [index, aircraft] of original.state.aircraft.entries()) {
      expect(copy.state.aircraft[index]!.position.distanceTo(aircraft.position)).toBeLessThan(0.01);
    }
    expect(copy.summary().aircraft.map((a) => a.hitsTaken)).toEqual(original.summary().aircraft.map((a) => a.hitsTaken));
  });

  it("shares nothing with the simulation it came from", () => {
    const original = new DogfightSimulation(scenario, { recordDecisions: false });
    fly(original, 200);
    const snapshot = original.snapshot();
    const copy = new DogfightSimulation(scenario, { recordDecisions: false });
    copy.restore(snapshot, original.state.events);
    copy.state.aircraft[0]!.position.x += 1_000;
    copy.state.events.push({ time: 0, type: "timeout" });
    expect(original.state.aircraft[0]!.position.x).not.toBe(copy.state.aircraft[0]!.position.x);
    expect(original.state.events.length).toBe(copy.state.events.length - 1);
  });
});
