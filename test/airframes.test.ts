import { describe, expect, it } from "vitest";
import { AIRFRAMES, AIRFRAME_IDS, GUNS, MISSILES, airframe, type AirframeId } from "../src/sim/airframes";
import { atmosphere } from "../src/sim/atmosphere";
import { stepAircraft } from "../src/sim/flight-model";
import { bestSustainedTurn, combatMass, cornerSpeed, specificExcessPower } from "../src/sim/performance";
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
  let peakAlpha = 0;
  let departed = false;
  for (let t = 0; t < seconds; t += DT) {
    stepAircraft(aircraft, DT);
    peakG = Math.max(peakG, aircraft.loadFactor);
    peakAlpha = Math.max(peakAlpha, aircraft.aoaRad);
    departed ||= aircraft.flcs.departed;
  }
  return { peakG, peakAlpha, departed };
}

describe.each(AIRFRAME_IDS)("the %s", (id) => {
  const frame = AIRFRAMES[id];

  it("trims and holds level flight for half a minute", () => {
    const aircraft = spawn(id);
    const start = { altitude: aircraft.position.y, speed: aircraft.velocity.length() };
    const flown = fly(aircraft, 30);
    expect(flown.departed).toBe(false);
    expect(Math.abs(aircraft.position.y - start.altitude)).toBeLessThan(40);
    expect(Math.abs(aircraft.velocity.length() - start.speed)).toBeLessThan(5);
  });

  it("pulls to its limits under full stick without departing", () => {
    const flown = fly(spawn(id, 220, 3_000), 6, { pitch: 1, throttle: 1 });
    expect(flown.departed).toBe(false);
    expect(flown.peakG).toBeLessThan(frame.flcs.maxLoadFactor + 0.6);
    expect(flown.peakAlpha).toBeLessThan(frame.flcs.alphaLimitRad + 0.03);
  });

  it("survives a full rolling pull at low speed", () => {
    expect(fly(spawn(id, 180, 3_000), 4, { pitch: 1, roll: 1, throttle: 1 }).departed).toBe(false);
  });

  it("starts a match with its own gun, fuel and weight", () => {
    const aircraft = spawn(id);
    expect(aircraft.airframe).toBe(id);
    expect(aircraft.ammo).toBe(frame.gun.ammunition);
    expect(aircraft.engine.fuelKg).toBeCloseTo(frame.mass.internalFuelKg * frame.mass.startFuelFraction, 0);
    expect(aircraft.massKg).toBeCloseTo(combatMass(frame), 0);
  });
});

describe("the roster, as sidegrades", () => {
  const card = Object.fromEntries(
    AIRFRAME_IDS.map((id) => {
      const frame = AIRFRAMES[id];
      const mass = combatMass(frame);
      return [
        id,
        {
          sustained: bestSustainedTurn(1_500, mass, frame).turnRateDegS,
          instant: cornerSpeed(1_500, mass, frame).turnRateDegS,
          energy: specificExcessPower(1_500, 0.9 * atmosphere(1_500).speedOfSoundMps, 1, mass, true, frame),
        },
      ];
    }),
  ) as Record<AirframeId, { sustained: number; instant: number; energy: number }>;
  const others = (id: AirframeId) => AIRFRAME_IDS.filter((other) => other !== id);

  it("gives the Hornet the highest angle of attack", () => {
    for (const id of others("fa18c")) {
      expect(AIRFRAMES.fa18c.flcs.alphaLimitRad).toBeGreaterThan(AIRFRAMES[id].flcs.alphaLimitRad);
    }
  });

  it("gives the Mirage the hardest first turn and the F-15 the most energy", () => {
    for (const id of others("m2000c")) expect(card.m2000c.instant).toBeGreaterThan(card[id].instant);
    for (const id of others("f15c")) expect(card.f15c.energy).toBeGreaterThan(card[id].energy);
  });

  it("makes the Mirage pay for its first turn in the sustained one", () => {
    expect(card.m2000c.sustained).toBeLessThan(card.f16c.sustained);
  });

  it("makes the F-5 the hardest to see and the big twins the easiest", () => {
    for (const id of others("f5e")) expect(AIRFRAMES.f5e.infrared).toBeLessThan(AIRFRAMES[id].infrared);
    expect(AIRFRAMES.su27s.infrared).toBeGreaterThan(AIRFRAMES.f16c.infrared);
    expect(AIRFRAMES.f15c.infrared).toBeGreaterThan(AIRFRAMES.f16c.infrared);
  });

  it("trades rounds for weight of shell", () => {
    expect(GUNS.gsh301.damageScale).toBeGreaterThan(GUNS.m61.damageScale);
    expect(GUNS.gsh301.ammunition).toBeLessThan(GUNS.m61.ammunition);
  });

  it("keeps every missile's seeker to an AIM-9M's reach, give or take", () => {
    for (const missile of Object.values(MISSILES)) {
      expect(missile.gimbalLimitRad).toBeLessThanOrEqual(MISSILES.aim9m.gimbalLimitRad + 0.1);
      expect(missile.acquisitionConeRad).toBeLessThanOrEqual(MISSILES.aim9m.acquisitionConeRad + 1e-9);
    }
  });
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
