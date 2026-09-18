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
        fire: gunSolution.inLethalRange && rangeM < 1_400,
      },
      rationale: "Lead pursuit, fire on solution",
    };
  }
}

/**
 * A competent reference opponent.
 *
 * The thing that makes it fly like a fighter rather than a guided missile is
 * energy. Turn performance peaks at corner speed and falls away hard on both
 * sides of it, so this agent spends g and throttle to hold the corner, and
 * treats maximum g as something you buy a shot with rather than the default.
 *
 * It is a rule-based pilot, not a good one. It exists to be the floor a model
 * has to clear.
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
   * several thousand feet doing it.
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
    const sustained = Math.max(own.sustainedLoadFactorG, 2);
    const maximum = Math.min(own.availableLoadFactorG, 9);
    // Terrain awareness, not just altitude: the clearance the current flight
    // path would leave is what says whether there is a hill in the way.
    const terrain = own.terrain;
    const veryLow = own.altitudeAglM < 900 || terrain.minimumClearanceAheadM < 700;
    const behindThem = relative.angleOffTailDeg < 70;
    const theyAreBehindUs = relative.antennaTrainAngleDeg > 120;
    const nearArenaEdge = observation.arena.distanceFromCentreM > observation.arena.radiusM * 0.8;

    let maneuver: Maneuver;
    let rationale: string;
    let disengaging = false;
    /** True when the fight is worth spending energy on, rather than saving it. */
    let committed = false;

    if (terrain.warning === "pull-up") {
      // Nothing in the fight is worth the ground. The automatic recovery will
      // already be pulling; committing the manoeuvre to it stops the agent
      // fighting its own GCAS.
      maneuver = "climb";
      committed = true;
      rationale = "Terrain: recovery does not fit, pulling up";
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
      // High ground ahead with no shot to give up for it: go over the top
      // rather than press on and be forced into a recovery later.
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

    /**
     * Energy policy: fly the corner.
     *
     * Above corner speed, pull harder and come out of afterburner -- the excess
     * speed is worth more as angles than as speed. Below it, stop pulling and
     * light the burner, because a jet under corner speed can neither turn nor
     * run. Getting this wrong in either direction is what makes an agent look
     * stupid: too much g and it spirals down to a hundred and forty metres a
     * second and sits there; too little and it sails past the fight at twice
     * corner with a two-kilometre turn radius.
     */
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
    if (terrain.warning === "pull-up") throttle = "ab";

    return {
      action: {
        schema: "tactical",
        maneuver,
        targetG,
        throttle,
        // The trigger is gated on the live gun solution, so this is an intent
        // to shoot when the pipper is on rather than a blind squeeze.
        fire: own.ammoRemaining > 0 && gunSolution.inLethalRange && relative.rangeM < 2_000,
      },
      rationale,
    };
  }
}
