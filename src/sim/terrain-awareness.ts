import { SEA_LEVEL_M, isWater, terrainElevation, terrainHeight } from "./terrain";

/**
 * What a pilot knows about the dirt, computed rather than left to the model.
 *
 * Height above ground alone is not terrain awareness. A jet 900 m above a
 * valley floor pointed at a ridge is in more trouble than one 300 m above a
 * lake, and nothing in a raw AGL reading says so. The numbers that actually
 * decide whether an aircraft is about to hit something are the clearance along
 * the projected flight path, the altitude a recovery would cost, and whether
 * the recovery fits in the space remaining -- so those are what the observation
 * carries.
 *
 * All of it is derived from the same analytic terrain the physics collides
 * against, so it cannot drift out of agreement with the ground the aircraft
 * will actually hit.
 */

const GRAVITY_MPS2 = 9.80665;

/** How far ahead the flight path is projected, seconds. */
const LOOK_AHEAD_S = 20;

/** Samples taken along that projection. */
const LOOK_AHEAD_SAMPLES = 24;

/** Radius of the survey used for nearby high ground, metres. */
const SURVEY_RADIUS_M = 12_000;

export type TerrainWarning = "clear" | "caution" | "pull-up";

export interface TerrainAwareness {
  /** Elevation of the surface directly below, metres above sea level. */
  groundElevationM: number;
  /** True when the surface below is water rather than land. */
  overWater: boolean;
  /** Height above the surface directly below, metres. */
  clearanceM: number;

  /**
   * Smallest clearance the current velocity vector would produce over the next
   * twenty seconds if it were held.
   *
   * This is the number that separates "high above the valley" from "level with
   * the ridge in front of you", and it is negative when the projection goes
   * into the ground.
   */
  minimumClearanceAheadM: number;
  /** When that minimum occurs, seconds from now. */
  timeToMinimumClearanceS: number;
  /**
   * Seconds until the held flight path reaches the surface, or null if it never
   * does within the look-ahead.
   *
   * Null rather than Infinity because this crosses the wire to agents as JSON,
   * and `JSON.stringify(Infinity)` is `null` anyway -- better to say so in the
   * type than to hand a remote model a field its schema claims is a number.
   */
  timeToImpactS: number | null;

  /** Altitude a maximum-effort pull to level would cost from here, metres. */
  recoveryHeightLossM: number;
  /**
   * Clearance remaining after that recovery. Negative means the pull does not
   * fit in the space available: the aircraft is already committed to the crash.
   */
  recoveryMarginM: number;

  /** Highest ground within the survey radius, metres above sea level. */
  highestNearbyM: number;
  /** Clearance above that high ground at the current altitude, metres. */
  clearanceOverHighestNearbyM: number;
  /** Compass heading toward the lowest ground nearby: where to run. */
  safestHeadingDeg: number;

  /** Summary the briefing can quote without recomputing the thresholds. */
  warning: TerrainWarning;
}

function compassHeading(east: number, south: number): number {
  // +z is south, so north is -z and the heading runs clockwise from there.
  return ((Math.atan2(east, -south) * 180) / Math.PI + 360) % 360;
}

/**
 * Altitude lost by pulling to level from a descent.
 *
 * The same geometry the automatic recovery uses: a constant-g pull traces an
 * arc of radius v^2 / (g(n-1)), and the height it consumes is the sagitta of
 * that arc through the current flight path angle. Capping the pull below the
 * structural limit keeps the estimate honest -- a recovery flown at the very
 * edge of the envelope is not one an agent should be counting on.
 */
export function recoveryHeightLossM(
  speedMps: number,
  flightPathAngleRad: number,
  availableLoadFactorG: number,
): number {
  if (flightPathAngleRad >= 0) return 0;
  const pullG = Math.max(Math.min(availableLoadFactorG, 5), 1.5);
  const radius = (speedMps * speedMps) / (GRAVITY_MPS2 * (pullG - 1));
  return radius * (1 - Math.cos(flightPathAngleRad));
}

export interface TerrainAwarenessInput {
  positionM: [number, number, number];
  velocityMps: [number, number, number];
  availableLoadFactorG: number;
  hardDeckAglM: number;
}

export function terrainAwareness(input: TerrainAwarenessInput): TerrainAwareness {
  const [x, y, z] = input.positionM;
  const [vx, vy, vz] = input.velocityMps;
  const speed = Math.hypot(vx, vy, vz);

  const groundElevationM = terrainHeight(x, z);
  const clearanceM = y - groundElevationM;

  // Project the velocity vector forward and find the worst clearance on it.
  // Straight-line, because that is precisely the question being asked: what
  // happens if nothing changes.
  let minimumClearanceAheadM = clearanceM;
  let timeToMinimumClearanceS = 0;
  let timeToImpactS: number | null = null;

  if (speed > 1) {
    for (let step = 1; step <= LOOK_AHEAD_SAMPLES; step += 1) {
      const t = (step / LOOK_AHEAD_SAMPLES) * LOOK_AHEAD_S;
      const clearance = y + vy * t - terrainHeight(x + vx * t, z + vz * t);
      if (clearance < minimumClearanceAheadM) {
        minimumClearanceAheadM = clearance;
        timeToMinimumClearanceS = t;
      }
      // The projection ends at the ground. Carrying on underneath it reports a
      // clearance of minus four kilometres, which is arithmetically true and
      // makes every number downstream of it nonsense.
      if (clearance <= 0) {
        timeToImpactS = t;
        break;
      }
    }
  }

  const flightPathAngleRad = speed > 1e-3 ? Math.asin(Math.max(-1, Math.min(1, vy / speed))) : 0;
  const loss = recoveryHeightLossM(speed, flightPathAngleRad, input.availableLoadFactorG);

  // The recovery has to fit above the ground the aircraft is descending toward,
  // not the ground it is over now.
  const clearanceAtRisk = Math.min(clearanceM, minimumClearanceAheadM);
  const recoveryMarginM = clearanceAtRisk - loss - input.hardDeckAglM;

  const survey = surveyNearbyTerrain(x, z);

  const warning: TerrainWarning =
    recoveryMarginM <= 0 || (timeToImpactS !== null && timeToImpactS < 10)
      ? "pull-up"
      : recoveryMarginM < Math.max(input.hardDeckAglM, 300) || minimumClearanceAheadM < input.hardDeckAglM
        ? "caution"
        : "clear";

  return {
    groundElevationM,
    overWater: isWater(x, z),
    clearanceM,
    minimumClearanceAheadM,
    timeToMinimumClearanceS,
    timeToImpactS,
    recoveryHeightLossM: loss,
    recoveryMarginM,
    highestNearbyM: survey.highestM,
    clearanceOverHighestNearbyM: y - Math.max(survey.highestM, SEA_LEVEL_M),
    safestHeadingDeg: survey.lowestHeadingDeg,
    warning,
  };
}

/**
 * Coarse survey of the ground around a point.
 *
 * Twelve bearings at three radii is enough to tell a ridge from a basin and to
 * point at the way out, and cheap enough to run on every observation. A finer
 * grid would report the same two numbers.
 */
function surveyNearbyTerrain(x: number, z: number): { highestM: number; lowestHeadingDeg: number } {
  const bearings = 12;
  const radii = [SURVEY_RADIUS_M / 3, (SURVEY_RADIUS_M * 2) / 3, SURVEY_RADIUS_M];

  let highestM = terrainElevation(x, z);
  let lowestM = Infinity;
  let lowestHeadingDeg = 0;

  for (let index = 0; index < bearings; index += 1) {
    const angle = (index / bearings) * Math.PI * 2;
    const east = Math.sin(angle);
    const south = -Math.cos(angle);

    // Rank a direction by its worst ground, so a heading is only "safe" when
    // nothing along it is high.
    let worstAlongBearing = -Infinity;
    for (const radius of radii) {
      const elevation = terrainElevation(x + east * radius, z + south * radius);
      if (elevation > highestM) highestM = elevation;
      if (elevation > worstAlongBearing) worstAlongBearing = elevation;
    }

    if (worstAlongBearing < lowestM) {
      lowestM = worstAlongBearing;
      lowestHeadingDeg = compassHeading(east, south);
    }
  }

  return { highestM, lowestHeadingDeg };
}
