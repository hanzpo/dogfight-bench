import type { AgentObservation } from "../sim/telemetry";
import { SCRIPTED_INFO, type AgentAdapter, type AgentDecision, type AgentInfo } from "./agent";
import type { Maneuver, ThrottleDetent } from "./action";

export class BasicPursuitAgent implements AgentAdapter {
  readonly info: AgentInfo;

  constructor(public readonly id: string) {
    this.info = SCRIPTED_INFO("basic-pursuit");
  }

  async decide(observation: AgentObservation): Promise<AgentDecision> {
    const { gunSolution, rangeM } = observation.relative;
    return {
      action: {
        schema: "tactical",
        maneuver: "lead_pursuit",
        targetG: 6,
        throttle: "ab",
        fire: gunSolution.inLethalRange && rangeM < 1_400,
      },
      rationale: "Lead pursuit, fire on solution",
    };
  }
}

export class EnergyFighterAgent implements AgentAdapter {
  readonly info: AgentInfo;
  private breakDirection: "break_left" | "break_right" = "break_left";
  private breakHeldUntilS = 0;
  private lastLaunchS = -Infinity;
  private lastFlaresS = -Infinity;
  /** One pair per missile: a pilot who empties the dispenser at every shot has none for the next. */
  private readonly flaredAgainst = new Set<string>();

  constructor(public readonly id: string) {
    this.info = SCRIPTED_INFO("energy-fighter");
  }

  reset(): void {
    this.breakDirection = "break_left";
    this.breakHeldUntilS = 0;
    this.lastLaunchS = -Infinity;
    this.lastFlaresS = -Infinity;
    this.flaredAgainst.clear();
  }

  private chooseBreak(observation: AgentObservation): "break_left" | "break_right" {
    if (observation.simTimeS < this.breakHeldUntilS) return this.breakDirection;
    this.breakDirection = observation.relative.bearingDeg >= 0 ? "break_right" : "break_left";
    this.breakHeldUntilS = observation.simTimeS + 4;
    return this.breakDirection;
  }

  async decide(observation: AgentObservation): Promise<AgentDecision> {
    const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
    const relative = observation.relative;
    const { gunSolution } = relative;

    const corner = own.cornerSpeedMps;
    const sustained = Math.max(own.sustainedLoadFactorG, 2);
    const maximum = Math.min(own.availableLoadFactorG, 9);
    const terrain = own.terrain;
    const veryLow = own.altitudeAglM < 900 || terrain.minimumClearanceAheadM < 700;
    const behindThem = relative.angleOffTailDeg < 70;
    const theyAreBehindUs = relative.antennaTrainAngleDeg > 120;
    const nearArenaEdge = observation.arena.distanceFromCentreM > observation.arena.radiusM * 0.8;
    const inbound = (observation.threats ?? [])
      .filter((threat) => threat.kind === "missile")
      .sort((a, b) => (a.timeToGoS ?? Infinity) - (b.timeToGoS ?? Infinity))[0];
    const missileClose = inbound !== undefined && ((inbound.timeToGoS ?? Infinity) < 7 || inbound.rangeM < 4_000);

    let maneuver: Maneuver;
    let rationale: string;
    let disengaging = false;
    let committed = false;

    if (terrain.warning === "pull-up") {
      maneuver = "climb";
      committed = true;
      rationale = "Terrain: recovery does not fit, pulling up";
    } else if (missileClose) {
      // Into the missile, which makes its line of sight swing fastest and
      // costs it the most energy to follow.
      maneuver = inbound.bearingDeg >= 0 ? "break_right" : "break_left";
      committed = true;
      rationale = "Defending a missile: breaking into it";
    } else if (relative.threatened && relative.rangeM < 1_800) {
      maneuver = veryLow ? this.chooseBreak(observation) : "defensive_spiral";
      committed = true;
      rationale = "Defending a gun solution";
    } else if (gunSolution.predictedMissM < 150 && relative.rangeM < 2_200) {
      maneuver = "lead_pursuit";
      committed = true;
      rationale = "Tracking for guns";
    } else if (theyAreBehindUs && relative.rangeM < 2_500) {
      maneuver = veryLow ? this.chooseBreak(observation) : "defensive_spiral";
      committed = true;
      rationale = "Turning into a threat in the rear quarter";
    } else if (veryLow && own.verticalSpeedMps < -30) {
      maneuver = "climb";
      rationale = "Climbing off the deck";
    } else if (terrain.warning === "caution" && !behindThem) {
      maneuver = "climb";
      rationale = "Terrain: climbing over high ground ahead";
    } else if (nearArenaEdge) {
      maneuver = "pure_pursuit";
      rationale = "Turning back toward the arena centre";
    } else if (behindThem && relative.rangeM < 3_500) {
      if (relative.closureRateMps > 160 && relative.rangeM < 1_500) {
        maneuver = "high_yoyo";
        rationale = "High yo-yo to kill closure";
      } else if (relative.rangeM < 700) {
        maneuver = "lag_pursuit";
        rationale = "Lag to hold the control zone";
      } else {
        maneuver = "lead_pursuit";
        rationale = "Converting to the control zone";
      }
    } else if (relative.energyAdvantageM < -1_500 && relative.rangeM > 6_000) {
      maneuver = "extend";
      disengaging = true;
      rationale = "Extending to rebuild an energy deficit";
    } else {
      maneuver = "lead_pursuit";
      rationale = "Turning into the fight";
    }

    const ratio = own.speedMps / Math.max(corner, 1);
    let targetG: number;
    let throttle: ThrottleDetent;
    if (disengaging) {
      targetG = 2;
      throttle = "ab";
    } else if (committed) {
      targetG = maximum;
      throttle = ratio > 1.25 ? "mil" : "ab";
    } else if (ratio > 1.15) {
      targetG = maximum;
      throttle = ratio > 1.45 ? "cruise" : "mil";
    } else if (ratio < 0.9) {
      targetG = Math.min(sustained, maximum);
      throttle = "ab";
    } else {
      targetG = Math.min(sustained + 1.5, maximum);
      throttle = "mil";
    }
    if (own.fuelKg < 250 && throttle === "ab") throttle = "mil";
    // Power back in the last seconds, so the flares outshine the tailpipe.
    if (missileClose && (inbound.timeToGoS ?? Infinity) < 4) throttle = "idle";
    if (terrain.warning === "pull-up") throttle = "ab";

    const now = observation.simTimeS;
    const flares =
      missileClose &&
      (inbound.timeToGoS ?? Infinity) < 2.5 &&
      !this.flaredAgainst.has(inbound.sourceId) &&
      own.flaresRemaining > 0 &&
      now - this.lastFlaresS >= 0.5;
    if (flares) {
      this.lastFlaresS = now;
      this.flaredAgainst.add(inbound.sourceId);
    }

    const missile = relative.missileSolution;
    const gunsWillDo = gunSolution.predictedMissM < 150 && relative.rangeM < 1_200;
    const launchMissile =
      missile !== undefined &&
      missile.locked &&
      missile.inRange &&
      own.missilesRemaining > 0 &&
      !gunsWillDo &&
      now - this.lastLaunchS >= 6;
    if (launchMissile) {
      this.lastLaunchS = now;
      rationale = `${rationale}; Fox 2`;
    }

    return {
      action: {
        schema: "tactical",
        maneuver,
        targetG,
        throttle,
        fire: own.ammoRemaining > 0 && gunSolution.inLethalRange && relative.rangeM < 2_000,
        ...(launchMissile ? { launchMissile: true } : {}),
        ...(flares ? { flares: true } : {}),
      },
      rationale,
    };
  }
}
