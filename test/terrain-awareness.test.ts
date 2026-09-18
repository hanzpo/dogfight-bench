import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { groundAvoidanceUrgency, type SteeringContext } from "../src/agents/autopilot";
import { isWater, terrainHeight } from "../src/sim/terrain";
import { terrainAwareness } from "../src/sim/terrain-awareness";

const HARD_DECK_M = 150;

function awareness(
  position: [number, number, number],
  velocity: [number, number, number],
  availableLoadFactorG = 9,
) {
  return terrainAwareness({ positionM: position, velocityMps: velocity, availableLoadFactorG, hardDeckAglM: HARD_DECK_M });
}

function steepestClimbingApproach(): { x: number; z: number; riseM: number } {
  let best = { x: 0, z: 0, riseM: -Infinity };
  for (let x = -25_000; x <= 25_000; x += 1_000) {
    for (let z = -25_000; z <= 25_000; z += 1_000) {
      const riseM = terrainHeight(x, z - 12_000) - terrainHeight(x, z);
      if (riseM > best.riseM) best = { x, z, riseM };
    }
  }
  return best;
}

function flatWaterPoint(): { x: number; z: number } | undefined {
  for (let x = -28_000; x <= 28_000; x += 1_000) {
    for (let z = -28_000; z <= 28_000; z += 1_000) {
      if (!isWater(x, z)) continue;
      let clear = true;
      for (let ahead = 1_000; ahead <= 13_000; ahead += 1_000) {
        if (!isWater(x, z - ahead)) clear = false;
      }
      if (clear) return { x, z };
    }
  }
  return undefined;
}

describe("terrain awareness", () => {
  it("reports the same surface the aircraft would collide with", () => {
    const point = awareness([4_321, 3_000, -1_234], [200, 0, 0]);
    expect(point.groundElevationM).toBe(terrainHeight(4_321, -1_234));
    expect(point.clearanceM).toBeCloseTo(3_000 - terrainHeight(4_321, -1_234), 6);
  });

  it("sees rising ground that height-above-ground alone would never report", () => {
    const ridge = steepestClimbingApproach();
    expect(ridge.riseM).toBeGreaterThan(500);

    const altitude = terrainHeight(ridge.x, ridge.z) + 800;
    const level = awareness([ridge.x, altitude, ridge.z], [0, 0, -250]);

    expect(level.clearanceM).toBeCloseTo(800, 6);
    expect(level.minimumClearanceAheadM).toBeLessThan(level.clearanceM);
    expect(level.timeToMinimumClearanceS).toBeGreaterThan(0);
    expect(level.warning).not.toBe("clear");
  });

  it("says nothing is wrong when nothing is", () => {
    const high = awareness([0, 6_000, 0], [220, 0, 0]);
    expect(high.warning).toBe("clear");
    expect(high.timeToImpactS).toBeNull();
    expect(high.recoveryMarginM).toBeGreaterThan(1_000);
  });

  it("calls for a pull-up when the recovery no longer fits", () => {
    const ground = terrainHeight(0, 0);
    const diving = awareness([0, ground + 900, 0], [0, -250, 0]);

    expect(diving.warning).toBe("pull-up");
    expect(diving.timeToImpactS).not.toBeNull();
    expect(diving.timeToImpactS!).toBeLessThan(6);
    expect(diving.recoveryHeightLossM).toBeGreaterThan(900);
    expect(diving.recoveryMarginM).toBeLessThan(0);
  });

  it("stops projecting at the ground rather than reporting depth underneath it", () => {
    const ground = terrainHeight(0, 0);
    const diving = awareness([0, ground + 900, 0], [0, -250, 0]);
    expect(diving.minimumClearanceAheadM).toBeGreaterThan(-400);
    expect(diving.timeToMinimumClearanceS).toBe(diving.timeToImpactS);
  });

  it("knows water from land", () => {
    const water = flatWaterPoint();
    expect(water).toBeDefined();
    const overSea = awareness([water!.x, 900, water!.z], [0, 0, -250]);
    expect(overSea.overWater).toBe(true);
    expect(overSea.groundElevationM).toBe(0);
    expect(overSea.warning).toBe("clear");
  });

  it("points at the lowest ground nearby as somewhere to run", () => {
    const ridge = steepestClimbingApproach();
    const here = awareness([ridge.x, terrainHeight(ridge.x, ridge.z) + 800, ridge.z], [0, 0, -250]);
    expect(here.safestHeadingDeg).toBeGreaterThanOrEqual(0);
    expect(here.safestHeadingDeg).toBeLessThan(360);
    expect(Math.abs(here.safestHeadingDeg - 0)).toBeGreaterThan(30);
  });
});

describe("automatic ground avoidance", () => {
  function context(position: Vector3, velocity: Vector3): SteeringContext {
    const speed = Math.max(velocity.length(), 1e-6);
    return {
      position,
      velocity,
      orientation: new Quaternion(),
      opponentPosition: position.clone().add(new Vector3(2_000, 0, 0)),
      opponentVelocity: velocity.clone(),
      altitudeAglM: position.y - terrainHeight(position.x, position.z),
      hardDeckAglM: HARD_DECK_M,
      availableLoadFactorG: 9,
      flightPathAngleRad: Math.asin(velocity.y / speed),
    };
  }

  it("recovers from level flight into rising ground", () => {
    const ridge = steepestClimbingApproach();
    const position = new Vector3(ridge.x, terrainHeight(ridge.x, ridge.z) + 300, ridge.z);
    expect(groundAvoidanceUrgency(context(position, new Vector3(0, 0, -250)))).toBeGreaterThan(0);
  });

  it("leaves level flight over flat ground alone", () => {
    const water = flatWaterPoint();
    expect(water).toBeDefined();
    const position = new Vector3(water!.x, 800, water!.z);
    expect(groundAvoidanceUrgency(context(position, new Vector3(0, 0, -250)))).toBe(0);
  });

  it("still recovers from a dive, which is the case it always handled", () => {
    const position = new Vector3(0, terrainHeight(0, 0) + 600, 0);
    expect(groundAvoidanceUrgency(context(position, new Vector3(0, -200, -150)))).toBeGreaterThan(0.5);
  });
});
