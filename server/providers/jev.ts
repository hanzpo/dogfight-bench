import { MANEUVERS, THROTTLE_DETENTS, validateAction } from "../../src/agents/action";
import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { MANEUVER_GUIDE } from "../prompt";
import type { ModelProvider } from "./types";

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

const TARGET_G = {
  "2": "Gentle, about 2 g. Preserves energy.",
  "4": "Moderate, about 4 g. Sustainable in most conditions.",
  "6": "Hard, about 6 g. Costs energy.",
  "8": "Very hard, about 8 g. Bleeds energy quickly.",
  "9": "Maximum, 9 g. Best instantaneous turn, worst energy cost.",
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

const RULES = `Fly an F-16C in a guns-only one-versus-one dogfight. Choose what to do for the next second.
Energy is speed plus altitude; specific excess power says whether you are gaining or losing it.
Hard turns cost energy, and a jet with no energy cannot fight. Corner speed is where the jet turns best.
Angle off tail near 0 means you are behind the bandit, which wins; near 180 means they are behind you.
The gun fires along the nose, so you must aim where the bandit will be. Predicted miss under 15 m hits.
Do not fire when the predicted miss is large: ammunition is finite.
If threatened, defend before anything else. The ground, the hard deck and the arena edge all kill.`;

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
      their_speed_mps: round(bandit.speedMps),
      their_integrity: round(bandit.health, 2),
      threatened_by_them: relative.threatened,
    },
    guns: {
      predicted_miss_m: round(Math.min(relative.gunSolution.predictedMissM, 9_999)),
      time_of_flight_s: round(relative.gunSolution.timeOfFlightS, 2),
      rounds_still_lethal: relative.gunSolution.inLethalRange,
      tracking_solution: relative.gunSolution.trackingSolution,
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

export class JevProvider implements ModelProvider {
  readonly id = "jev";

  /** Fire only when the model is actually confident, not merely on argmax. */
  constructor(private readonly fireConfidence = 0.6) {}

  available(): boolean {
    return Boolean(env.typesafeApiKey);
  }

  describe(): AgentInfo {
    return {
      name: `jev/${env.typesafeModel}`,
      provider: "jev",
      model: env.typesafeModel,
      policyVersion: "bfm-choices-1",
      schema: "tactical",
    };
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const body = {
      model: env.typesafeModel,
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
        authorization: `Bearer ${requireKey(env.typesafeApiKey, "TYPESAFE_API_KEY")}`,
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
