import { validateAction } from "../../src/agents/action";
import type { AgentDecision, AgentInfo, ChoiceDistribution } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { buildBriefing } from "../prompt";
import { clamp } from "../../src/math";
import {
  askSystemOne,
  firstSentence,
  readChoice,
  readNoul,
  readScore,
  type ChoiceAnswer,
  type ScoreAnswer,
} from "./system-one";
import type { ModelProvider, ProviderOptions } from "./types";

/**
 * Jev flying the stick, rather than naming a manoeuvre for an autopilot.
 *
 * Every axis is a `score`, not a `choice`. That is the whole reason this is
 * worth trying again: the previous stick entrant offered five detents per axis
 * and asked Jev to pick one, which is a discrete answer to a continuous
 * question. A score comes back as a probability-weighted mean, so "mostly pull,
 * a little right" lands at 0.68 rather than snapping to `hard_pull`.
 *
 * It is the harder interface at a decision a second. Nothing interprets the
 * answer and nothing keeps flying it: a deflection chosen once is frozen until
 * the next one, where a manoeuvre is a goal an autopilot chases at simulation
 * rate. Whether the extra resolution is worth losing that is the question this
 * entrant exists to answer.
 */

/**
 * Each axis is asked twice: which way, and how much.
 *
 * A score is a probability-weighted mean, so asking a signed axis as one
 * five-rung scale from "full left" to "full right" averages the two opposite
 * answers into the middle -- and the middle of a control axis is "do nothing",
 * the one answer that is certainly wrong. Measured, every axis came back inside
 * a twentieth of centre and the aeroplane flew straight.
 *
 * A `choice` cannot average across its options, so it carries the direction. A
 * `score` is exactly right for the magnitude, where the mean between "some" and
 * "a lot" is a real amount. Multiplied, they give a deflection that is
 * continuous and can still reach the stops.
 */
const HOW_MUCH = [
  "Barely: a nudge, holding what is already there.",
  "A little.",
  "A firm input, the sort held through a working turn.",
  "Most of what is available.",
  "Everything: against the stop.",
] as const;

/** Not evenly spaced, for the same reason the load factor scale is not. */
const MAGNITUDE = [0.05, 0.3, 0.6, 0.85, 1] as const;

const PITCH_WAY = {
  pull: "Aft stick. The nose needs to come up or round: towards the bandit, away from the ground, into the turn.",
  push: "Forward stick. Unload: the pull is costing more speed than the angles are worth, or the nose is above where it should be.",
};

const ROLL_WAY = {
  left: "Roll left, to put the lift vector left of where it is now.",
  right: "Roll right, to put the lift vector right of where it is now.",
};

/**
 * Three ways, because a choice cannot abstain.
 *
 * Asked as left-or-right the answer was always one of them, and the magnitude
 * beside it settled near the middle, so the jet flew with half a boot of rudder
 * held permanently on -- slewing the nose and bleeding energy for nothing. Most
 * of the time the honest answer is neither.
 */
const YAW_WAY = {
  left: "Left pedal, to bring the nose left of where the bank alone is taking it.",
  centre: "Feet off. The turn is coordinated and the rudder has no work to do, which is usually the case.",
  right: "Right pedal, to bring the nose right of where the bank alone is taking it.",
};

const THROTTLE = [
  "Idle: closing far too fast, or about to overshoot.",
  "Back off: a little fast for the turn being flown.",
  "Enough to hold the current speed.",
  "Military power, because speed is needed or is being lost.",
  "Afterburner, everything the engine has.",
] as const;

const THROTTLE_FRACTION = [0, 0.35, 0.62, 0.85, 1] as const;

function alongScale(scale: readonly number[], score: number): number {
  const low = clamp(Math.floor(score), 0, scale.length - 1);
  const high = Math.min(low + 1, scale.length - 1);
  return scale[low]! + (scale[high]! - scale[low]!) * (score - low);
}

/** Direction times magnitude, as one signed deflection. */
function deflect(way: ChoiceAnswer, negative: string, amount: ScoreAnswer): number {
  return (way.choice === negative ? -1 : 1) * alongScale(MAGNITUDE, amount.score);
}

function axisDistribution(question: string, way: ChoiceAnswer, amount: ScoreAnswer, value: number): ChoiceDistribution {
  return {
    question: `${question} ${value >= 0 ? "+" : ""}${value.toFixed(2)}`,
    choice: way.choice,
    confidence: way.confidence,
    options: Object.entries(way.probabilities)
      .map(([id, probability]) => ({ id, probability }))
      .concat({ id: `${(alongScale(MAGNITUDE, amount.score) * 100).toFixed(0)}% of it`, probability: amount.confidence })
      .sort((a, b) => b.probability - a.probability),
  };
}

const QUESTIONS = {
  pitch_way: { type: "choice", instructions: "Should the stick go aft or forward?", criteria: PITCH_WAY },
  pitch_amount: { type: "score", instructions: "How much stick, in that direction?", criteria: HOW_MUCH },
  roll_way: { type: "choice", instructions: "Should the aircraft roll left or right?", criteria: ROLL_WAY },
  roll_amount: { type: "score", instructions: "How much roll, in that direction?", criteria: HOW_MUCH },
  yaw_way: { type: "choice", instructions: "Which pedal, if either? Usually neither.", criteria: YAW_WAY },
  yaw_amount: { type: "score", instructions: "How much pedal? Almost always barely any.", criteria: HOW_MUCH },
  throttle: { type: "score", instructions: "Where should the throttle be?", criteria: THROTTLE },
  fire: {
    type: "noul",
    instructions: "Would a burst fired this instant hit the bandit?",
    criteria: {
      true: "A burst now would be worth firing: the predicted miss is within a few tens of metres and the rounds are still lethal at that range.",
      false: "A burst now would be thrown away: the predicted miss is hundreds of metres, or the bandit is far beyond lethal range.",
    },
  },
};

export class JevStickProvider implements ModelProvider {
  readonly id = "jev-stick";

  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(
    options: ProviderOptions = {},
    private readonly fireConfidence = 0.45,
  ) {
    this.model = options.model ?? env.typesafeModel;
    this.apiKey = options.apiKey ?? env.typesafeApiKey;
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  describe(): AgentInfo {
    return {
      name: `jev/${this.model}`,
      provider: "jev-stick",
      model: this.model,
      policyVersion: "stick-scores-1",
      schema: "raw",
    };
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const result = await askSystemOne(
      { url: env.typesafeUrl, key: requireKey(this.apiKey, "TYPESAFE_API_KEY"), model: this.model },
      buildBriefing(observation, false),
      QUESTIONS,
      signal,
    );
    const answers = result.answers ?? {};
    const pitchWay = readChoice(answers["pitch_way"], Object.keys(PITCH_WAY));
    const rollWay = readChoice(answers["roll_way"], Object.keys(ROLL_WAY));
    const yawWay = readChoice(answers["yaw_way"], Object.keys(YAW_WAY));
    const pitchAmount = readScore(answers["pitch_amount"], HOW_MUCH.length);
    const rollAmount = readScore(answers["roll_amount"], HOW_MUCH.length);
    const yawAmount = readScore(answers["yaw_amount"], HOW_MUCH.length);
    const throttle = readScore(answers["throttle"], THROTTLE.length);
    const fire = readNoul(answers["fire"]);

    const controls = {
      pitch: deflect(pitchWay, "push", pitchAmount),
      roll: deflect(rollWay, "left", rollAmount),
      yaw: yawWay.choice === "centre" ? 0 : deflect(yawWay, "left", yawAmount),
      throttle: alongScale(THROTTLE_FRACTION, throttle.score),
      fire: fire >= this.fireConfidence,
    };

    return {
      distributions: [
        axisDistribution("pitch", pitchWay, pitchAmount, controls.pitch),
        axisDistribution("roll", rollWay, rollAmount, controls.roll),
        axisDistribution("yaw", yawWay, yawAmount, controls.yaw),
        {
          question: `throttle ${(controls.throttle * 100).toFixed(0)}%`,
          choice: firstSentence(THROTTLE[Math.round(throttle.score)] ?? ""),
          confidence: throttle.confidence,
          options: Object.entries(throttle.probabilities ?? {})
            .map(([level, probability]) => ({
              id: firstSentence(throttle.legend?.[level] ?? THROTTLE[Number(level)] ?? level),
              probability,
            }))
            .sort((a, b) => b.probability - a.probability),
        },
        {
          question: "fire",
          choice: fire >= 0.5 ? "shoot" : "hold",
          confidence: Math.abs(fire - 0.5) * 2,
          options: [
            { id: "shoot", probability: fire },
            { id: "hold", probability: 1 - fire },
          ].sort((a, b) => b.probability - a.probability),
        },
      ],
      action: validateAction({ schema: "raw", controls }),
      rationale:
        `stick ${controls.pitch >= 0 ? "aft" : "fwd"} ${Math.abs(controls.pitch).toFixed(2)}, ` +
        `roll ${controls.roll.toFixed(2)}, yaw ${controls.yaw.toFixed(2)}, ` +
        `${(controls.throttle * 100).toFixed(0)}% power, shoot ${(fire * 100).toFixed(0)}%`,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        costUsd: result.usage?.cost_usd ?? 0,
      },
    };
  }
}
