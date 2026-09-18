import { describe, expect, it } from "vitest";
import { atmosphere } from "../src/sim/atmosphere";
import { FLCS, MASS } from "../src/sim/config";
import { stepAircraft } from "../src/sim/flight-model";
import {
  bestSustainedTurn,
  cornerSpeed,
  maximumLevelSpeed,
  specificExcessPower,
  stallSpeed,
  sustainedLoadFactor,
} from "../src/sim/performance";
import { trimLevelFlight } from "../src/sim/trim";
import { DT, currentBank, fly, makeTestAircraft, turnRateDegS } from "./helpers/envelope";
import { degrees } from "../src/math";
import { clamp } from "../src/math";

const COMBAT_MASS = MASS.emptyKg + MASS.internalFuelKg * MASS.startFuelFraction;

describe("atmosphere", () => {
  it("matches the standard atmosphere at reference altitudes", () => {
    expect(atmosphere(0).densityKgM3).toBeCloseTo(1.225, 3);
    expect(atmosphere(0).speedOfSoundMps).toBeCloseTo(340.29, 1);
    expect(atmosphere(5_000).densityKgM3).toBeCloseTo(0.7364, 3);
    expect(atmosphere(5_000).temperatureK).toBeCloseTo(255.65, 1);
    expect(atmosphere(11_000).densityKgM3).toBeCloseTo(0.3639, 3);
    expect(atmosphere(11_000).pressurePa).toBeCloseTo(22_632, -2);
    expect(atmosphere(15_000).temperatureK).toBeCloseTo(216.65, 2);
  });
});

describe("level flight", () => {
  it.each([
    [1_000, 200],
    [4_500, 250],
    [9_000, 280],
  ])("holds trim at %i m and %i m/s for a minute", (altitudeM, speedMps) => {
    const aircraft = makeTestAircraft({ altitudeM, speedMps });
    fly(aircraft, 60, {});
    expect(Math.abs(aircraft.position.y - altitudeM)).toBeLessThan(25);
    expect(Math.abs(aircraft.velocity.length() - speedMps)).toBeLessThan(3);
    expect(aircraft.loadFactor).toBeCloseTo(1, 1);
    expect(aircraft.flcs.departed).toBe(false);
  });

  it("needs more power to hold height as altitude increases", () => {
    const low = trimLevelFlight(1_000, 250, COMBAT_MASS);
    const high = trimLevelFlight(9_000, 250, COMBAT_MASS);
    expect(high.throttle).toBeGreaterThan(low.throttle);
    expect(high.alphaRad).toBeGreaterThan(low.alphaRad);
  });

  it("burns fuel and gets lighter", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 250 });
    const startFuel = aircraft.engine.fuelKg;
    const startMass = aircraft.massKg;
    fly(aircraft, 60, { throttle: 1 });
    expect(aircraft.engine.fuelKg).toBeLessThan(startFuel);
    expect(aircraft.massKg).toBeLessThan(startMass);
    expect(aircraft.engine.afterburner).toBe(true);
  });

  it("burns far more fuel in afterburner than at military power", () => {
    const military = makeTestAircraft({ altitudeM: 4_500, speedMps: 250 });
    const burner = makeTestAircraft({ altitudeM: 4_500, speedMps: 250 });
    fly(military, 30, { throttle: 0.85 });
    fly(burner, 30, { throttle: 1 });
    const militaryBurn = MASS.internalFuelKg * MASS.startFuelFraction - military.engine.fuelKg;
    const burnerBurn = MASS.internalFuelKg * MASS.startFuelFraction - burner.engine.fuelKg;
    expect(burnerBurn).toBeGreaterThan(militaryBurn * 1.8);
  });
});

describe("energy manoeuvrability", () => {
  it("sustains a credible turn rate at low altitude", () => {
    const seaLevel = bestSustainedTurn(0, COMBAT_MASS);
    expect(seaLevel.turnRateDegS).toBeGreaterThan(16);
    expect(seaLevel.turnRateDegS).toBeLessThan(22);

    const medium = bestSustainedTurn(4_500, COMBAT_MASS);
    expect(medium.turnRateDegS).toBeGreaterThan(11);
    expect(medium.turnRateDegS).toBeLessThan(16);
    expect(medium.turnRateDegS).toBeLessThan(seaLevel.turnRateDegS);
  });

  it("reaches roughly 26 deg/s instantaneous at the corner", () => {
    const corner = cornerSpeed(1_500, COMBAT_MASS);
    expect(corner.turnRateDegS).toBeGreaterThan(24);
    expect(corner.turnRateDegS).toBeLessThan(31);
    expect(corner.loadFactor).toBeCloseTo(FLCS.maxLoadFactor, 1);
    expect(corner.speedMps).toBeGreaterThan(160);
    expect(corner.speedMps).toBeLessThan(215);
  });

  it("is always able to turn harder instantaneously than it can sustain", () => {
    for (const altitude of [0, 3_000, 6_000, 9_000]) {
      expect(cornerSpeed(altitude, COMBAT_MASS).turnRateDegS).toBeGreaterThan(
        bestSustainedTurn(altitude, COMBAT_MASS).turnRateDegS,
      );
    }
  });

  it("produces published specific excess power at 1 g", () => {
    const ps = specificExcessPower(0, 306, 1, COMBAT_MASS);
    expect(ps).toBeGreaterThan(200);
    expect(ps).toBeLessThan(290);
    expect(specificExcessPower(4_500, 250, 9, COMBAT_MASS)).toBeLessThan(0);
    expect(sustainedLoadFactor(4_500, 250, COMBAT_MASS)).toBeGreaterThan(3);
    expect(sustainedLoadFactor(4_500, 250, COMBAT_MASS)).toBeLessThan(7);
  });

  it("is supersonic at altitude and transonic at sea level", () => {
    expect(maximumLevelSpeed(11_000) / atmosphere(11_000).speedOfSoundMps).toBeGreaterThan(1.75);
    expect(maximumLevelSpeed(11_000) / atmosphere(11_000).speedOfSoundMps).toBeLessThan(2.25);
    const seaLevelMach = maximumLevelSpeed(0) / atmosphere(0).speedOfSoundMps;
    expect(seaLevelMach).toBeGreaterThan(1.0);
    expect(seaLevelMach).toBeLessThan(1.3);
  });

  it("stalls slowly enough to be a fighter", () => {
    expect(stallSpeed(0, COMBAT_MASS)).toBeGreaterThan(50);
    expect(stallSpeed(0, COMBAT_MASS)).toBeLessThan(75);
  });

  it("flies the analytic sustained point at roughly zero excess power", () => {
    for (const altitude of [1_500, 4_500]) {
      const target = bestSustainedTurn(altitude, COMBAT_MASS);
      const aircraft = makeTestAircraft({ altitudeM: altitude, speedMps: target.speedMps });
      const bank = Math.acos(Math.min(1, 1 / target.loadFactor));
      for (let i = 0; i < 2 / DT; i += 1) {
        aircraft.controls = {
          pitch: (target.loadFactor - 1) / (FLCS.maxLoadFactor - 1),
          roll: clamp((bank - currentBank(aircraft)) * 1.2 - aircraft.angularVelocity.x * 0.3, -1, 1),
          yaw: 0,
          throttle: 1,
          fire: false,
        };
        stepAircraft(aircraft, DT);
      }
      expect(aircraft.loadFactor).toBeGreaterThan(target.loadFactor * 0.85);
      expect(Math.abs(aircraft.specificExcessPowerMps)).toBeLessThan(60);
      expect(Math.abs(aircraft.specificExcessPowerMps)).toBeLessThan(
        specificExcessPower(altitude, target.speedMps, 1, COMBAT_MASS) * 0.5,
      );
      expect(Math.abs(turnRateDegS(aircraft))).toBeGreaterThan(target.turnRateDegS * 0.8);
    }
  });
});

describe("flight control system", () => {
  it("reaches commanded g within a second and holds it", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 300 });
    fly(aircraft, 1, { pitch: 0.5, throttle: 1 });
    expect(aircraft.loadFactor).toBeGreaterThan(4.5);
    fly(aircraft, 4, { pitch: 0.5, throttle: 1 });
    expect(aircraft.loadFactor).toBeGreaterThan(4.6);
    expect(aircraft.loadFactor).toBeLessThan(5.6);
  });

  it("never exceeds the structural limit under full aft stick", () => {
    const aircraft = makeTestAircraft({ altitudeM: 1_500, speedMps: 320 });
    let peak = 0;
    for (let i = 0; i < 6 / DT; i += 1) {
      aircraft.controls = { pitch: 1, roll: 0, yaw: 0, throttle: 1, fire: false };
      stepAircraft(aircraft, DT);
      peak = Math.max(peak, aircraft.loadFactor);
    }
    expect(peak).toBeGreaterThan(8.4);
    expect(peak).toBeLessThan(FLCS.maxLoadFactor + 0.6);
  });

  it("limits angle of attack and never departs on stick alone", () => {
    for (const speed of [130, 180, 250, 320]) {
      const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: speed });
      let peakAlpha = 0;
      let departed = false;
      for (let i = 0; i < 15 / DT; i += 1) {
        aircraft.controls = { pitch: 1, roll: 0, yaw: 0, throttle: 1, fire: false };
        stepAircraft(aircraft, DT);
        peakAlpha = Math.max(peakAlpha, Math.abs(aircraft.aoaRad));
        departed ||= aircraft.flcs.departed;
      }
      expect(departed).toBe(false);
      expect(peakAlpha).toBeLessThan(FLCS.alphaLimitRad + 0.02);
    }
  });

  it("rolls at the commanded rate and stops when the stick centres", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 300 });
    fly(aircraft, 0.6, { roll: 1, throttle: 0.9 });
    const rollRate = degrees(aircraft.angularVelocity.x);
    expect(rollRate).toBeGreaterThan(270);
    expect(rollRate).toBeLessThan(340);
    fly(aircraft, 1, { roll: 0, throttle: 0.9 });
    expect(Math.abs(aircraft.angularVelocity.x)).toBeLessThan(0.2);
  });

  it("rolls the way the stick is moved and turns that way when pulled", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 260 });
    fly(aircraft, 0.3, { roll: 1, throttle: 1 });
    expect(currentBank(aircraft)).toBeGreaterThan(0.3);
    fly(aircraft, 2, { roll: 0, pitch: 0.6, throttle: 1 });
    expect(turnRateDegS(aircraft)).toBeGreaterThan(5);
  });

  it("keeps a hard turn roughly coordinated without pedal input", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 280 });
    fly(aircraft, 0.4, { roll: 1, throttle: 1 });
    fly(aircraft, 4, { roll: 0, pitch: 0.7, throttle: 1 });
    expect(Math.abs(aircraft.sideslipRad)).toBeLessThan(0.12);
  });

  it("commands sideslip when the pedals are used", () => {
    const aircraft = makeTestAircraft({ altitudeM: 4_500, speedMps: 250 });
    fly(aircraft, 3, { yaw: 1, throttle: 0.9 });
    expect(aircraft.sideslipRad).toBeLessThan(-0.05);
    expect(aircraft.sideslipRad).toBeGreaterThan(-0.3);
  });
});
