import { describe, expect, it } from "vitest";
import { AIRFRAMES, AIRFRAME_IDS, airframe, type AirframeId } from "../src/sim/airframes";
import { stepAircraft } from "../src/sim/flight-model";
import { ReplayRecorder, parseReplay } from "../src/sim/replay";
import { fox2Merge, neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import type { AircraftState } from "../src/sim/types";

const DT = 1 / 120;

function spawn(id: AirframeId, speedMps = 250, altitudeM = 6_000): AircraftState {
  const sim = new DogfightSimulation({
    ...neutralMerge,
    startSpeedMps: speedMps,
    startAltitudeM: altitudeM,
    airframes: { "blue-1": id },
  });
  return sim.state.aircraft[0]!;
}

function fly(aircraft: AircraftState, seconds: number, controls: Partial<AircraftState["controls"]> = {}) {
  aircraft.commandedControls = { ...aircraft.commandedControls, ...controls };
  let peakG = 0;
  let departed = false;
  for (let t = 0; t < seconds; t += DT) {
    stepAircraft(aircraft, DT);
    peakG = Math.max(peakG, aircraft.loadFactor);
    departed ||= aircraft.flcs.departed;
  }
  return { peakG, departed };
}

// Every jet flies the same control laws on its own numbers; the case that has
// gone wrong before is a departure in a hard rolling pull at low speed.
it.each(AIRFRAME_IDS)("the %s survives a full rolling pull within its g limit", (id) => {
  const frame = AIRFRAMES[id];
  const flown = fly(spawn(id, 180, 3_000), 4, { pitch: 1, roll: 1, throttle: 1 });
  expect(flown.departed).toBe(false);
  expect(flown.peakG).toBeLessThan(frame.flcs.maxLoadFactor + 0.6);
});

describe("mixed fights", () => {
  it("fires 30 mm from a MiG slower than an F-16 fires 20 mm", async () => {
    const sim = new DogfightSimulation({ ...neutralMerge, airframes: { "blue-1": "mig29a" } });
    const [mig, viper] = sim.state.aircraft as [AircraftState, AircraftState];
    mig.commandedControls = { ...mig.commandedControls, fire: true };
    viper.commandedControls = { ...viper.commandedControls, fire: true };
    for (let tick = 0; tick < 30; tick += 1) sim.step();
    const speed = (owner: string) => {
      const shot = sim.state.projectiles.find((projectile) => projectile.ownerId === owner)!;
      const shooter = sim.state.aircraft.find((aircraft) => aircraft.id === owner)!;
      return shot.velocity.clone().sub(shooter.velocity).length();
    };
    expect(speed("blue-1")).toBeLessThan(speed("red-1") - 100);
  });

  it("launches the carrier's own missile", () => {
    const sim = new DogfightSimulation({ ...fox2Merge, airframes: { "blue-1": "su27s", "red-1": "f5e" } });
    const [flanker, tiger] = sim.state.aircraft as [AircraftState, AircraftState];
    flanker.commandedControls = { ...flanker.commandedControls, missile: true };
    tiger.commandedControls = { ...tiger.commandedControls, missile: true };
    for (let tick = 0; tick < 10; tick += 1) sim.step();
    expect(sim.state.missiles.map((missile) => missile.kind).sort()).toEqual(["aim9p", "r73"]);
  });

  it("records which aeroplanes flew, so a replay draws the right ones", () => {
    const sim = new DogfightSimulation({ ...neutralMerge, airframes: { "blue-1": "jas39c", "red-1": "f15c" } });
    const recorder = new ReplayRecorder(sim.config, {});
    for (let tick = 0; tick < 16; tick += 1) {
      sim.step();
      recorder.capture(sim.state);
    }
    expect(parseReplay(recorder.toJSON()).scenario.airframes).toEqual({ "blue-1": "jas39c", "red-1": "f15c" });
  });

  it("falls back to an F-16 for a seat nobody named", () => {
    const sim = new DogfightSimulation({ ...neutralMerge, airframes: { "blue-1": "f5e" } });
    expect(sim.state.aircraft.map((aircraft) => aircraft.airframe)).toEqual(["f5e", "f16c"]);
    expect(airframe(undefined).id).toBe("f16c");
  });
});
