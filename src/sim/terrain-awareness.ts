import { SEA_LEVEL_M, isWater, terrainElevation, terrainHeight } from "./terrain";

const GRAVITY_MPS2 = 9.80665;

const LOOK_AHEAD_S = 20;

const LOOK_AHEAD_SAMPLES = 24;

const SURVEY_RADIUS_M = 12_000;

export type TerrainWarning = "clear" | "caution" | "pull-up";

export interface TerrainAwareness {
  groundElevationM: number;
  overWater: boolean;
  clearanceM: number;

  minimumClearanceAheadM: number;
  timeToMinimumClearanceS: number;
  timeToImpactS: number | null;

  recoveryHeightLossM: number;
  recoveryMarginM: number;

  highestNearbyM: number;
  clearanceOverHighestNearbyM: number;
  safestHeadingDeg: number;

  warning: TerrainWarning;
}

function compassHeading(east: number, south: number): number {
  return ((Math.atan2(east, -south) * 180) / Math.PI + 360) % 360;
}

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
      if (clearance <= 0) {
        timeToImpactS = t;
        break;
      }
    }
  }

  const flightPathAngleRad = speed > 1e-3 ? Math.asin(Math.max(-1, Math.min(1, vy / speed))) : 0;
  const loss = recoveryHeightLossM(speed, flightPathAngleRad, input.availableLoadFactorG);

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
