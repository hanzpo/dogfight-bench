import type { AgentObservation } from "../sim/telemetry";
import { SCRIPTED_INFO, type AgentAdapter, type AgentDecision, type AgentInfo } from "./agent";
import type { Maneuver, ThrottleDetent } from "./action";

/**
 * Scripted opponents.
 *
 * These exist to give the benchmark a fixed reference point. A model that
 * cannot beat `EnergyFighterAgent` has not learned basic air combat, and a
 * model that loses to `BasicPursuitAgent` is not flying at all.
 */

/**
 * The floor. Points the nose at the opponent and fires when it is close and
 * roughly aligned. It has no concept of energy, so it will happily fly itself
 * into a slow-speed fight it cannot win.
 */
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
        fire: gunSolution.trackingSolution && rangeM < 1_400,
      },
      rationale: "Lead pursuit, fire on solution",
    };
  }
}

/**
 * A competent reference opponent.
 *
 * It manages energy, refuses to turn with someone who has an angular
 * advantage on it, uses the vertical, and disengages to rebuild speed when it
 * is losing. It is a rule-based pilot, not a good one, but it plays the actual
 * game rather than chasing the nose.
 */
export class EnergyFighterAgent implements AgentAdapter {
  readonly info: AgentInfo;
  /** The side of the last break, so the jet does not thrash left and right. */
  private breakDirection: "break_left" | "break_right" = "break_left";
  private breakHeldUntilS = 0;

  constructor(public readonly id: string) {
    this.info = SCRIPTED_INFO("energy-fighter");
  }

  reset(): void {
    this.breakDirection = "break_left";
    this.breakHeldUntilS = 0;
  }

  /**
   * Picks a break direction and commits to it for a few seconds. Reversing
   * every time the bearing crosses zero rolls the jet back and forth and loses
   * several thousand feet doing it, which is how this agent used to lose.
   */
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
    const slow = own.speedMps < corner * 0.7;
    const fast = own.speedMps > corner * 1.5;
    const low = own.altitudeAglM < 1_500;
    const behindThem = relative.angleOffTailDeg < 60;
    const theyAreBehindUs = relative.antennaTrainAngleDeg > 120;
    const nearArenaEdge = observation.arena.distanceFromCentreM > observation.arena.radiusM * 0.8;

    let maneuver: Maneuver;
    let targetG = 5;
    let throttle: ThrottleDetent = "ab";
    let rationale: string;

    if (relative.threatened && relative.rangeM < 1_800) {
      // Being shot at. Nothing else matters.
      maneuver = low ? this.chooseBreak(observation) : "defensive_spiral";
      targetG = 9;
      rationale = "Defending a gun solution";
    } else if (low && own.verticalSpeedMps < -40) {
      // Close to the floor and going down: buy height back before anything else.
      maneuver = "climb";
      targetG = 4;
      rationale = "Climbing off the deck";
    } else if (gunSolution.trackingSolution || (gunSolution.aimErrorDeg < 12 && relative.rangeM < 2_500)) {
      maneuver = "lead_pursuit";
      targetG = 8;
      rationale = "Tracking for guns";
    } else if (theyAreBehindUs && relative.rangeM < 2_500) {
      // Someone is in the rear quarter without a shot yet: turn into them
      // rather than running, which only gives them a stern conversion.
      maneuver = low ? this.chooseBreak(observation) : "defensive_spiral";
      targetG = 8;
      rationale = "Turning into a threat in the rear quarter";
    } else if (nearArenaEdge) {
      maneuver = "pure_pursuit";
      targetG = 6;
      rationale = "Turning back toward the arena centre";
    } else if (slow && !theyAreBehindUs) {
      // Out of energy and nobody is immediately behind: go and get some back.
      maneuver = low ? "level" : "dive";
      targetG = 2;
      throttle = "ab";
      rationale = "Trading altitude for corner speed";
    } else if (behindThem && relative.rangeM < 3_000) {
      if (relative.closureRateMps > 180 && relative.rangeM < 1_500) {
        maneuver = "high_yoyo";
        targetG = 6;
        throttle = "mil";
        rationale = "High yo-yo to kill closure";
      } else if (relative.rangeM < 800) {
        maneuver = "lag_pursuit";
        targetG = 6;
        throttle = "mil";
        rationale = "Lag to hold the control zone";
      } else {
        maneuver = "lead_pursuit";
        targetG = 8;
        rationale = "Converting to the control zone";
      }
    } else if (relative.energyAdvantageM < -900 && relative.rangeM > 4_000) {
      maneuver = own.altitudeAglM < 4_000 ? "climb" : "extend";
      targetG = 2;
      rationale = "Rebuilding an energy deficit at range";
    } else if (fast && relative.rangeM < 2_500) {
      maneuver = "low_yoyo";
      targetG = 6;
      throttle = "mil";
      rationale = "Low yo-yo to convert speed into angles";
    } else {
      // Nothing else applies: go and find the fight. Breaking away from an
      // opponent who is kilometres away just ends the engagement.
      maneuver = "pure_pursuit";
      targetG = 7;
      rationale = "Re-engaging";
    }

    if (own.fuelKg < 250) throttle = "mil";

    return {
      action: {
        schema: "tactical",
        maneuver,
        targetG,
        throttle,
        fire: own.ammoRemaining > 0 && gunSolution.inLethalRange && gunSolution.predictedMissM < 18,
      },
      rationale,
    };
  }
}
