import { Euler, Quaternion, Vector3 } from "three";
import { GUN, MASS } from "./config";
import { createDamageState } from "./damage";
import { thrustAtPower } from "./engine";
import { createFlcsState } from "./flcs";
import { atmosphere } from "./atmosphere";
import { Random } from "./random";
import { trimLevelFlight, trimPower } from "./trim";
import type { AircraftState, MatchState, ScenarioConfig, Team } from "./types";

export const neutralMerge: ScenarioConfig = {
  id: "neutral-merge-v2",
  seed: 0xd06f16,
  fixedDt: 1 / 120,
  maxTime: 300,
  originLatitudeDeg: 36.0,
  originLongitudeDeg: -115.0,
  startAltitudeM: 6_000,
  startSpeedMps: 250,
  startSeparationM: 8_000,
  startLateralOffsetM: 0,
  startAltitudeSplitM: 0,
  startHeadingCrossingDeg: 180,
  hardDeckAglM: 150,
  arenaRadiusM: 30_000,
};

interface Placement {
  id: string;
  team: Team;
  position: Vector3;
  headingDeg: number;
}

/**
 * Both jets are placed on a line through the origin, nose-on to the merge
 * point. `startHeadingCrossingDeg` is the angle between their velocity
 * vectors: 180 is a pure head-on pass, 90 a beam crossing.
 */
function placements(config: ScenarioConfig): [Placement, Placement] {
  const half = config.startSeparationM / 2;
  const lateral = config.startLateralOffsetM / 2;
  const split = config.startAltitudeSplitM / 2;
  /**
   * Each aircraft is turned off the head-on line by the same amount.
   *
   * The crossing angle used to be applied entirely to red: blue flew due north
   * every time and red did all of the turning. At a beam crossing that is not a
   * variation of the same fight, it is a different fight for each side -- one
   * aircraft pointing at the merge and the other cutting across it -- and in
   * self-play between identical agents it showed up as red winning nine of ten
   * short matches. Splitting the deviation keeps the angle between the two
   * velocity vectors exactly `startHeadingCrossingDeg` while asking the same of
   * both.
   */
  const deviation = (180 - config.startHeadingCrossingDeg) / 2;
  return [
    {
      id: "blue-1",
      team: "blue",
      position: new Vector3(-lateral, config.startAltitudeM - split, -half),
      headingDeg: deviation,
    },
    {
      id: "red-1",
      team: "red",
      position: new Vector3(lateral, config.startAltitudeM + split, half),
      headingDeg: 180 - deviation,
    },
  ];
}

function makeAircraft(placement: Placement, config: ScenarioConfig): AircraftState {
  const fuelKg = MASS.internalFuelKg * MASS.startFuelFraction;
  const massKg = MASS.emptyKg + fuelKg;
  const trim = trimLevelFlight(placement.position.y, config.startSpeedMps, massKg);

  // Heading is a compass bearing; yaw about +y maps north -> east for positive
  // angles, and the trim alpha is applied as nose-up pitch.
  const yaw = (placement.headingDeg * Math.PI) / 180;
  const orientation = new Quaternion().setFromEuler(new Euler(-trim.alphaRad, yaw, 0, "YXZ"));
  const velocity = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(config.startSpeedMps);

  const air = atmosphere(placement.position.y);
  const power = trimPower(trim.throttle);

  return {
    id: placement.id,
    team: placement.team,
    position: placement.position.clone(),
    velocity,
    acceleration: new Vector3(),
    orientation,
    angularVelocity: new Vector3(),
    controls: { pitch: 0, roll: 0, yaw: 0, throttle: trim.throttle, fire: false },
    flcs: createFlcsState(),
    engine: {
      power,
      fuelKg,
      thrustN: thrustAtPower(power, placement.position.y, config.startSpeedMps / air.speedOfSoundMps),
      fuelFlowKgS: 0,
      afterburner: power > 1.02,
    },
    massKg,
    aoaRad: trim.alphaRad,
    sideslipRad: 0,
    loadFactor: 1,
    mach: config.startSpeedMps / air.speedOfSoundMps,
    specificExcessPowerMps: 0,
    heightAboveGroundM: placement.position.y,
    ammo: GUN.ammunition,
    gunAccumulator: 0,
    gunSpin: 0,
    roundsThisBurst: 0,
    damage: createDamageState(),
    health: 1,
    alive: true,
  };
}

export function createNeutralMerge(config: ScenarioConfig = neutralMerge): MatchState {
  const [blue, red] = placements(config);
  return {
    time: 0,
    tick: 0,
    aircraft: [makeAircraft(blue, config), makeAircraft(red, config)],
    projectiles: [],
    events: [],
    finished: false,
  };
}

/**
 * Deterministic scenario variations.
 *
 * A single symmetric head-on merge is a weak benchmark: it rewards whoever
 * happens to win the first pass. Seeded variants spread the starting geometry
 * across offsets, altitude splits and crossing angles so a model has to be
 * good at more than one picture.
 */
export function scenarioVariant(seed: number, base: ScenarioConfig = neutralMerge): ScenarioConfig {
  const rng = new Random(seed);
  const spread = (magnitude: number) => (rng.next() * 2 - 1) * magnitude;
  return {
    ...base,
    id: `${base.id}+v${seed}`,
    seed,
    startAltitudeM: base.startAltitudeM + spread(1_200),
    startSpeedMps: base.startSpeedMps + spread(45),
    startSeparationM: base.startSeparationM + spread(2_000),
    startLateralOffsetM: spread(1_800),
    startAltitudeSplitM: spread(1_500),
    startHeadingCrossingDeg: 180 - Math.abs(spread(70)),
  };
}

/**
 * The mirror image of a variant: the same fight from the other side.
 *
 * Only the two quantities that hand one aircraft an advantage are negated --
 * the altitude split and the lateral offset. Everything else is shared by both
 * jets and reversing it would make a different fight rather than the same one.
 */
export function mirrorScenario(scenario: ScenarioConfig): ScenarioConfig {
  return {
    ...scenario,
    id: `${scenario.id}m`,
    startAltitudeSplitM: -scenario.startAltitudeSplitM,
    startLateralOffsetM: -scenario.startLateralOffsetM,
  };
}

/**
 * A fixed, reproducible ladder of variants used by the benchmark runner.
 *
 * Emitted in mirrored pairs, so the set is even-handed by construction. Drawn
 * independently the offsets do not cancel: ten variants came out with a mean
 * altitude split of nearly four hundred metres, which is a real advantage
 * handed to one side for free. The match runner also flies both sides of every
 * scenario, but anything that makes a single pass -- a quick sweep, a self-play
 * check -- would otherwise be measuring the draw rather than the pilots.
 *
 * An odd count keeps the unpaired variant last, so `scenarioSet(1)` is still
 * one scenario.
 */
export function scenarioSet(count: number, base: ScenarioConfig = neutralMerge): ScenarioConfig[] {
  const scenarios: ScenarioConfig[] = [];
  for (let index = 0; scenarios.length < count; index += 1) {
    const variant = scenarioVariant(base.seed + index * 7919, base);
    scenarios.push(variant);
    if (scenarios.length < count) scenarios.push(mirrorScenario(variant));
  }
  return scenarios;
}
