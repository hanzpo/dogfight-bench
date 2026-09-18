import { MANEUVERS, THROTTLE_DETENTS, THROTTLE_VALUES, validateAction } from "../../src/agents/action";
import type { AgentDecision, AgentInfo, ChoiceDistribution } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { MANEUVER_GUIDE } from "../prompt";
import type { ModelProvider, ProviderOptions } from "./types";

/**
 * Jev, through TypeSafe's System One endpoint.
 *
 * Jev is not an autoregressive model that writes an answer -- it is a
 * classifier that picks among choices you define and returns calibrated
 * probabilities over them. That happens to be exactly the shape of the tactical
 * action space, so the whole decision is one request with four questions, and
 * the probabilities are worth something: the trigger is gated on the model's
 * own confidence rather than on a bare argmax.
 */

/**
 * What each load factor buys, not only what it costs.
 *
 * The first version of this described 2 g as preserving energy and every
 * setting above it as costing, bleeding or draining energy. A calibrated model
 * reading that picked 2 g on ninety decisions out of ninety, flew a whole match
 * without ever pointing the nose at anything, and lost -- correctly, because it
 * did what it was told. Turning is the thing the g is for; the descriptions
 * have to say so, or the choice is between one good option and four warnings.
 */
const TARGET_G = {
  "2": "About 2 g. Barely turns. For running away, extending, or flying straight while you rebuild speed.",
  "4": "About 4 g. A steady turn you can hold for a long time without losing much.",
  "6": "About 6 g. A hard turn that moves the nose quickly. Costs speed you will have to rebuild.",
  "8": "About 8 g. Very hard. Close to the limit, and the fastest way to bring the nose onto a bandit.",
  "9": "Maximum, 9 g. The best turn the jet has. What you pull to convert a position into a shot.",
} as const;

const THROTTLE_GUIDE: Record<(typeof THROTTLE_DETENTS)[number], string> = {
  idle: "Throttle closed. Decelerate hard.",
  cruise: "Part power. Hold speed while saving fuel.",
  mil: "Full dry thrust. No afterburner.",
  ab: "Full afterburner. Maximum thrust and fuel flow.",
};

const FIRE = {
  FIRE: "Squeeze the trigger this second.",
  HOLD: "Hold fire and keep manoeuvring.",
} as const;

/**
 * The other way to fly the same aircraft: the stick itself.
 *
 * The tactical schema asks for a named manoeuvre and lets an autopilot fly it
 * continuously until the next answer. This asks for control positions, which
 * are applied directly and then held until the next answer -- nothing
 * interprets them and nothing keeps flying them. That makes it a harder
 * interface at one decision a second, and a fairer measure of whether a model
 * understands what a control surface does rather than what a manoeuvre is
 * called. Both fly the identical airframe through the identical flight control
 * system, so the two are worth comparing.
 */
const PITCH = {
  hard_push: "Stick hard forward. Unload to negative g; the nose drops fast.",
  push: "Stick forward. Ease the nose down and stop pulling.",
  neutral: "Stick centred. One g, nose follows the flight path.",
  pull: "Stick back. A firm pull, roughly half of what the jet has.",
  hard_pull: "Stick fully back. Maximum available g; the limiter holds the angle of attack.",
} as const;

const ROLL = {
  hard_left: "Full left stick. Fastest roll to the left.",
  left: "Left stick. A measured roll to the left.",
  level: "Lateral stick centred. Hold the current bank.",
  right: "Right stick. A measured roll to the right.",
  hard_right: "Full right stick. Fastest roll to the right.",
} as const;

const RUDDER = {
  left: "Left pedal. Yaws the nose left; costs energy.",
  centre: "Pedals neutral. No sideslip.",
  right: "Right pedal. Yaws the nose right; costs energy.",
} as const;

const STICK_VALUES = {
  pitch: { hard_push: -1, push: -0.45, neutral: 0, pull: 0.5, hard_pull: 1 },
  roll: { hard_left: -1, left: -0.45, level: 0, right: 0.45, hard_right: 1 },
  rudder: { left: -0.4, centre: 0, right: 0.4 },
} as const;

const STICK_RULES = `Fly an F-16C in a guns-only one-versus-one dogfight. You are moving the stick, the pedals and the
throttle directly. Your inputs are held until your next answer, so choose a position you want to hold for about a
second, not an instant twitch.
Positive pitch is stick back, which pulls g and brings the nose up through the aircraft's own vertical.
To turn, roll the lift vector onto the direction you want and then pull; pulling with the wings level only climbs.
Energy is speed plus altitude. Hard pulls cost it, but a fight is won by pointing the nose, and a gentle pull never
points it in time. Near corner speed, pull hard.
The gun fires along the nose, so you must aim where the bandit will be, not where it is. Guns gives you that lead:
lead_bearing_deg is how far right (positive) or left (negative) of your nose the lead point sits, and
lead_elevation_deg how far above (positive) or below it. Roll so that pulling moves the nose toward the lead point,
then pull; bring both to zero and the burst connects. Predicted miss under 15 m hits.
Nothing gates your trigger: if you say fire, the gun fires, and ammunition is finite.
If threatened, defend before anything else. The ground, the hard deck and the arena edge all kill.`;

const RULES = `Fly an F-16C in a guns-only one-versus-one dogfight. Choose what to do for the next second.
Energy is speed plus altitude; specific excess power says whether you are gaining or losing it.
Hard turns cost energy, and a jet with no energy cannot fight -- but a turn too gentle to move the nose
never produces a shot either, and a fight is won by pointing the nose. Corner speed is where the jet turns
best: near it, pull hard. Spend g to gain angles, and unload to rebuild speed once you have them.
Angle off tail near 0 means you are behind the bandit, which wins; near 180 means they are behind you.
The gun fires along the nose, so you must aim where the bandit will be, not where it is. Guns gives you that lead:
lead_bearing_deg is how far right (positive) or left (negative) of your nose the lead point sits, and
lead_elevation_deg how far above (positive) or below it. Bring both to zero and the burst connects.
Predicted miss under 15 m hits. Do not fire when the predicted miss is large: ammunition is finite.
If threatened, defend before anything else. The ground, the hard deck and the arena edge all kill.
The ground is not flat. Terrain gives the clearance this flight path would leave over the next twenty seconds,
what a recovery costs, and whether it still fits. On a pull-up warning, recover before anything else:
flying level into a ridge is a collision that height above the ground underneath will never warn you about.`;

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, ChoiceAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
}

/** Mirrors the upstream validation: a malformed answer must not become an action. */
function validateChoice(answer: ChoiceAnswer | undefined, ids: readonly string[]): ChoiceAnswer {
  const probabilities = answer?.probabilities;
  const values = probabilities ? Object.values(probabilities) : [];
  const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const valid =
    answer !== undefined &&
    ids.includes(answer.choice) &&
    probabilities !== undefined &&
    new Set(Object.keys(probabilities)).size === ids.length &&
    ids.every((id) => id in probabilities) &&
    [...values, answer.confidence].every(finite) &&
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) < 0.02;
  if (!valid) throw new Error("Invalid TypeSafe response; no action taken");
  return answer;
}

/**
 * Hands every answer's probabilities on intact.
 *
 * Jev's whole output is a set of calibrated distributions rather than a sampled
 * choice, so keeping only the argmax throws away most of what it said.
 */
function distributionsOf(answers: ReadonlyArray<readonly [string, ChoiceAnswer]>): ChoiceDistribution[] {
  return answers.map(([question, answer]) => ({
    question,
    choice: answer.choice,
    confidence: answer.confidence,
    options: Object.entries(answer.probabilities)
      .map(([id, probability]) => ({ id, probability }))
      .sort((a, b) => b.probability - a.probability),
  }));
}

function state(observation: AgentObservation) {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  const bandit = observation.aircraft.find((aircraft) => aircraft.id === observation.relative.opponentId)!;
  const relative = observation.relative;
  const round = (value: number, digits = 0) => Number(value.toFixed(digits));
  return {
    ownship: {
      speed_mps: round(own.speedMps),
      corner_speed_mps: round(own.cornerSpeedMps),
      mach: round(own.mach, 2),
      altitude_m: round(own.altitudeM),
      height_above_ground_m: round(own.altitudeAglM),
      vertical_speed_mps: round(own.verticalSpeedMps),
      specific_energy_m: round(own.specificEnergyM),
      specific_excess_power_mps: round(own.specificExcessPowerMps),
      load_factor_g: round(own.loadFactorG, 1),
      available_g: round(own.availableLoadFactorG, 1),
      sustainable_g: round(own.sustainedLoadFactorG, 1),
      // Turn performance, which is what the g is for.
      turn_rate_deg_s: round(own.turnRateDegS, 1),
      turn_radius_m: Number.isFinite(own.turnRadiusM) ? round(own.turnRadiusM) : null,
      angle_of_attack_deg: round(own.angleOfAttackDeg, 1),
      bank_deg: round(own.rollDeg),
      heading_deg: round(own.headingDeg),
      track_deg: round(own.trackDeg),
      alpha_limited: own.limiterActive,
      departed: own.departed,
      ammo: own.ammoRemaining,
      fuel_kg: round(own.fuelKg),
      integrity: round(own.health, 2),
    },
    bandit: {
      range_m: round(relative.rangeM),
      closure_mps: round(relative.closureRateMps),
      bearing_deg: round(relative.bearingDeg),
      elevation_deg: round(relative.elevationDeg),
      angle_off_tail_deg: round(relative.angleOffTailDeg),
      off_our_nose_deg: round(relative.antennaTrainAngleDeg),
      line_of_sight_rate_deg_s: round(relative.lineOfSightRateDegS, 1),
      energy_advantage_m: round(relative.energyAdvantageM),
      altitude_advantage_m: round(relative.altitudeAdvantageM),
      their_speed_mps: round(bandit.speedMps),
      their_altitude_m: round(bandit.altitudeM),
      their_load_factor_g: round(bandit.loadFactorG, 1),
      their_turn_rate_deg_s: round(bandit.turnRateDegS, 1),
      their_ammo: bandit.ammoRemaining,
      their_integrity: round(bandit.health, 2),
      threatened_by_them: relative.threatened,
    },
    guns: {
      predicted_miss_m: round(Math.min(relative.gunSolution.predictedMissM, 9_999)),
      time_of_flight_s: round(relative.gunSolution.timeOfFlightS, 2),
      rounds_still_lethal: relative.gunSolution.inLethalRange,
      tracking_solution: relative.gunSolution.trackingSolution,
      /**
       * Where the nose has to point, not where the bandit is.
       *
       * These were missing, which left the model knowing how far its burst
       * would miss by and nothing about which way to move to fix it. The
       * briefing the other adapters read has carried them all along, so their
       * absence here was also a handicap this one model was carrying alone.
       */
      aim_error_deg: round(relative.gunSolution.aimErrorDeg, 1),
      lead_bearing_deg: round(relative.gunSolution.leadBearingDeg, 1),
      lead_elevation_deg: round(relative.gunSolution.leadElevationDeg, 1),
      lead_range_m: round(relative.gunSolution.leadRangeM),
    },
    terrain: {
      ground_elevation_m: round(own.terrain.groundElevationM),
      over_water: own.terrain.overWater,
      clearance_m: round(own.terrain.clearanceM),
      // What the clearance becomes if this flight path is held, which is the
      // only number that sees a ridge before it arrives.
      minimum_clearance_ahead_m: round(own.terrain.minimumClearanceAheadM),
      seconds_to_minimum_clearance: round(own.terrain.timeToMinimumClearanceS, 1),
      seconds_to_impact: own.terrain.timeToImpactS === null ? null : round(own.terrain.timeToImpactS, 1),
      recovery_costs_m: round(own.terrain.recoveryHeightLossM),
      recovery_margin_m: round(own.terrain.recoveryMarginM),
      highest_ground_within_12km_m: round(own.terrain.highestNearbyM),
      lowest_ground_heading_deg: round(own.terrain.safestHeadingDeg),
      warning: own.terrain.warning,
    },
    arena: {
      hard_deck_agl_m: observation.arena.hardDeckAglM,
      distance_from_centre_m: round(observation.arena.distanceFromCentreM),
      radius_m: observation.arena.radiusM,
      seconds_remaining: round(observation.timeRemainingS),
    },
    recent_events: observation.recentEvents.slice(-6).map((event) => ({
      type: event.type,
      actor: event.actorId,
      detail: event.detail,
    })),
  };
}

/** Which interface the model is being asked to fly through. */
export type JevSchema = "tactical" | "raw";

export class JevProvider implements ModelProvider {
  readonly id: string;

  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly schema: JevSchema;

  constructor(
    options: ProviderOptions & { schema?: JevSchema } = {},
    /** Fire only when the model is actually confident, not merely on argmax. */
    private readonly fireConfidence = 0.6,
  ) {
    this.model = options.model ?? env.typesafeModel;
    this.apiKey = options.apiKey ?? env.typesafeApiKey;
    this.schema = options.schema ?? "tactical";
    this.id = this.schema === "raw" ? "jev-stick" : "jev";
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * The two schemas are two different pilots.
   *
   * Same model, same credential, different interface -- so they get different
   * policy versions and rank separately. Folding them together would average a
   * model's grasp of tactics with its grasp of aerodynamics and report one
   * number that means neither.
   */
  describe(): AgentInfo {
    return this.schema === "raw"
      ? {
          name: `jev/${this.model}`,
          provider: "jev",
          model: this.model,
          policyVersion: "stick-choices-2",
          schema: "raw",
        }
      : {
          name: `jev/${this.model}`,
          provider: "jev",
          model: this.model,
          policyVersion: "bfm-choices-3",
          schema: "tactical",
        };
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    return this.schema === "raw" ? this.decideStick(observation, signal) : this.decideTactical(observation, signal);
  }

  /** One request, five questions, and the answer is a set of control positions. */
  private async decideStick(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const result = await this.ask(
      {
        pitch: {
          type: "choice",
          criteria: PITCH,
          instructions: { goal: "Longitudinal stick for the next second.", rules: STICK_RULES },
        },
        roll: {
          type: "choice",
          criteria: ROLL,
          instructions: { goal: "Lateral stick for the next second.", rules: STICK_RULES },
        },
        rudder: {
          type: "choice",
          criteria: RUDDER,
          instructions: { goal: "Pedals for the next second.", rules: STICK_RULES },
        },
        throttle: {
          type: "choice",
          criteria: Object.fromEntries(THROTTLE_DETENTS.map((detent) => [detent, THROTTLE_GUIDE[detent]])),
          instructions: { goal: "Throttle setting for the next second.", rules: STICK_RULES },
        },
        fire: {
          type: "choice",
          criteria: FIRE,
          instructions: { goal: "Whether to squeeze the trigger right now.", rules: STICK_RULES },
        },
      },
      signal,
      observation,
    );

    const answers = result.answers ?? {};
    const pitch = validateChoice(answers["pitch"], Object.keys(PITCH));
    const roll = validateChoice(answers["roll"], Object.keys(ROLL));
    const rudder = validateChoice(answers["rudder"], Object.keys(RUDDER));
    const throttle = validateChoice(answers["throttle"], THROTTLE_DETENTS);
    const fire = validateChoice(answers["fire"], Object.keys(FIRE));

    // Nothing gates a raw trigger, so the confidence threshold is the only
    // thing between a guess and a wasted burst.
    const fireProbability = fire.probabilities["FIRE"] ?? 0;

    return {
      distributions: distributionsOf([
        ["pitch", pitch],
        ["roll", roll],
        ["rudder", rudder],
        ["throttle", throttle],
        ["fire", fire],
      ]),
      action: validateAction({
        schema: "raw",
        controls: {
          pitch: STICK_VALUES.pitch[pitch.choice as keyof typeof STICK_VALUES.pitch],
          roll: STICK_VALUES.roll[roll.choice as keyof typeof STICK_VALUES.roll],
          yaw: STICK_VALUES.rudder[rudder.choice as keyof typeof STICK_VALUES.rudder],
          throttle: THROTTLE_VALUES[throttle.choice as (typeof THROTTLE_DETENTS)[number]],
          fire: fire.choice === "FIRE" && fireProbability >= this.fireConfidence,
        },
      }),
      rationale: `stick ${pitch.choice}/${roll.choice}, ${throttle.choice} (confidence ${pitch.confidence.toFixed(2)}), fire probability ${fireProbability.toFixed(2)}`,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        costUsd: result.usage?.cost_usd ?? 0,
      },
    };
  }

  /** Posts one set of questions and returns the parsed response. */
  private async ask(
    questions: Record<string, unknown>,
    signal: AbortSignal | undefined,
    observation: AgentObservation,
  ): Promise<SystemOneResponse> {
    const response = await fetch(env.typesafeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requireKey(this.apiKey, "TYPESAFE_API_KEY")}`,
      },
      signal,
      body: JSON.stringify({ model: this.model, state: state(observation), questions }),
    });
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as SystemOneResponse;
  }

  private async decideTactical(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const body = {
      model: this.model,
      state: state(observation),
      questions: {
        maneuver: {
          type: "choice",
          criteria: Object.fromEntries(MANEUVERS.map((maneuver) => [maneuver, MANEUVER_GUIDE[maneuver]])),
          instructions: { goal: "Win the dogfight.", rules: RULES },
        },
        target_g: {
          type: "choice",
          criteria: TARGET_G,
          instructions: { goal: "How hard to pull through the manoeuvre.", rules: RULES },
        },
        throttle: {
          type: "choice",
          criteria: Object.fromEntries(THROTTLE_DETENTS.map((detent) => [detent, THROTTLE_GUIDE[detent]])),
          instructions: { goal: "Throttle setting for the next second.", rules: RULES },
        },
        fire: {
          type: "choice",
          criteria: FIRE,
          instructions: { goal: "Whether the rounds would connect right now.", rules: RULES },
        },
      },
    };

    const response = await fetch(env.typesafeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requireKey(this.apiKey, "TYPESAFE_API_KEY")}`,
      },
      signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${await response.text()}`);

    const result = (await response.json()) as SystemOneResponse;
    const answers = result.answers ?? {};
    const maneuver = validateChoice(answers["maneuver"], MANEUVERS);
    const targetG = validateChoice(answers["target_g"], Object.keys(TARGET_G));
    const throttle = validateChoice(answers["throttle"], THROTTLE_DETENTS);
    const fire = validateChoice(answers["fire"], Object.keys(FIRE));

    // Jev reports calibrated probabilities, so the trigger can be gated on
    // confidence rather than on the winning choice alone.
    const fireProbability = fire.probabilities["FIRE"] ?? 0;
    const shooting = fire.choice === "FIRE" && fireProbability >= this.fireConfidence;

    return {
      distributions: distributionsOf([
        ["maneuver", maneuver],
        ["target_g", targetG],
        ["throttle", throttle],
        ["fire", fire],
      ]),
      action: validateAction({
        schema: "tactical",
        maneuver: maneuver.choice,
        targetG: Number(targetG.choice),
        throttle: throttle.choice,
        fire: shooting,
      }),
      rationale: `${maneuver.choice} at ${targetG.choice} g (confidence ${maneuver.confidence.toFixed(2)}), fire probability ${fireProbability.toFixed(2)}`,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        costUsd: result.usage?.cost_usd ?? 0,
      },
    };
  }
}
