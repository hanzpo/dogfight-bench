import {
  MANEUVERS,
  THROTTLE_DETENTS,
  THROTTLE_VALUES,
  validateAction,
  type Maneuver,
  type ThrottleDetent,
} from "../../src/agents/action";
import type { AgentDecision, AgentInfo, ChoiceDistribution } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { MANEUVER_GUIDE, buildBriefing } from "../prompt";
import type { ModelProvider, ProviderOptions } from "./types";

const COMMITMENT = [
  "Unload. Stop turning: speed is the problem, or the bandit is far enough away that pointing costs nothing.",
  "A working turn the jet can hold all day, giving up nothing on energy.",
  "Hard. More than it can sustain, trading speed for the nose coming round.",
  "Very hard. Nearly everything, because the angles decide this and the speed does not.",
  "On the limiter. Maximum instantaneous turn -- a guns defence, or the last few degrees to a shot.",
] as const;

/**
 * What each rung of the rubric above is worth. Not evenly spaced: four of the
 * five describe a jet that is turning and one does not, and a score is a
 * probability-weighted mean, so an even 1..9 put every uncertain answer at 4 g
 * -- which in a 9 g aeroplane cannot stay inside anybody.
 */
const COMMITMENT_G = [1, 5, 6.8, 8.2, 9] as const;

const POWER = [
  "Idle. Closing far too fast, or about to overshoot, and the closure has to stop.",
  "Back off. A little fast for the turn being flown; less power settles it.",
  "Enough to hold the current speed and spend nothing extra.",
  "Military power, full dry thrust, because speed is needed or is being lost.",
  "Afterburner, everything the engine has, to run, to climb, or to hold a hard turn.",
] as const;

const POWER_FRACTION = [0, 0.35, 0.62, 0.85, 1] as const;

function nearestDetent(fraction: number): ThrottleDetent {
  let nearest: ThrottleDetent = THROTTLE_DETENTS[0];
  for (const detent of THROTTLE_DETENTS) {
    if (Math.abs(THROTTLE_VALUES[detent] - fraction) < Math.abs(THROTTLE_VALUES[nearest] - fraction)) {
      nearest = detent;
    }
  }
  return nearest;
}

function alongScale(scale: readonly number[], score: number): number {
  const low = Math.max(0, Math.min(scale.length - 1, Math.floor(score)));
  const high = Math.min(low + 1, scale.length - 1);
  return scale[low]! + (scale[high]! - scale[low]!) * (score - low);
}

interface ChoiceAnswer {
  type?: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface ScoreAnswer {
  type?: string;
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

interface NoulAnswer {
  type?: string;
  noul: number;
}

interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function require<T>(valid: boolean, answer: T | undefined, kind: string): T {
  if (!valid || answer === undefined) throw new Error(`Invalid TypeSafe ${kind}; no action taken`);
  return answer;
}

function firstSentence(text: string): string {
  return text.split(".")[0]!;
}

function readChoice(value: unknown, ids: readonly string[]): ChoiceAnswer {
  const answer = value as ChoiceAnswer | undefined;
  const probabilities = answer?.probabilities;
  const values = probabilities ? Object.values(probabilities) : [];
  const valid =
    answer !== undefined &&
    ids.includes(answer.choice) &&
    probabilities !== undefined &&
    ids.every((id) => id in probabilities) &&
    [...values, answer.confidence].every(probability) &&
    Math.abs(values.reduce((sum, entry) => sum + entry, 0) - 1) < 0.02;
  return require(valid, answer, "choice");
}

function readScore(value: unknown, levels: number): ScoreAnswer {
  const answer = value as ScoreAnswer | undefined;
  const valid =
    answer !== undefined &&
    finite(answer.score) &&
    answer.score >= 0 &&
    answer.score <= levels - 1 &&
    probability(answer.confidence);
  return require(valid, answer, "score");
}

function readNoul(value: unknown): number {
  const answer = value as NoulAnswer | undefined;
  return require(probability(answer?.noul), answer?.noul, "noul");
}

function distributionsOf(
  maneuver: ChoiceAnswer,
  commitment: ScoreAnswer,
  power: ScoreAnswer,
  fire: number,
): ChoiceDistribution[] {
  const fromScore = (question: string, answer: ScoreAnswer, rubric: readonly string[]): ChoiceDistribution => ({
    question,
    choice: rubric[Math.round(answer.score)] ? firstSentence(rubric[Math.round(answer.score)]!) : answer.score.toFixed(2),
    confidence: answer.confidence,
    options: Object.entries(answer.probabilities ?? {})
      .map(([level, value]) => ({
        id: firstSentence(answer.legend?.[level] ?? rubric[Number(level)] ?? level),
        probability: value,
      }))
      .sort((a, b) => b.probability - a.probability),
  });

  return [
    {
      question: "manoeuvre",
      choice: maneuver.choice,
      confidence: maneuver.confidence,
      options: Object.entries(maneuver.probabilities)
        .map(([id, value]) => ({ id, probability: value }))
        .sort((a, b) => b.probability - a.probability),
    },
    fromScore("commitment", commitment, COMMITMENT),
    fromScore("power", power, POWER),
    {
      question: "fire",
      choice: fire >= 0.5 ? "shoot" : "hold",
      confidence: Math.abs(fire - 0.5) * 2,
      options: [
        { id: "shoot", probability: fire },
        { id: "hold", probability: 1 - fire },
      ].sort((a, b) => b.probability - a.probability),
    },
  ];
}

const QUESTIONS = {
  maneuver: {
    type: "choice",
    instructions: "Which manoeuvre should the pilot fly for the next few seconds?",
    criteria: Object.fromEntries(MANEUVERS.map((name) => [name, MANEUVER_GUIDE[name]])),
  },
  commitment: {
    type: "score",
    instructions: "How hard should the pilot pull through that manoeuvre?",
    criteria: COMMITMENT,
  },
  power: {
    type: "score",
    instructions: "How much thrust should the pilot be carrying?",
    criteria: POWER,
  },
  fire: {
    type: "noul",
    instructions: "Would a burst fired this instant hit the bandit?",
    /**
     * Asked strictly, answered generously. Naming the predicted miss distance
     * -- which the briefing reports with its threshold beside it -- cut shots
     * that would pass a kilometre wide. Demanding an exact solution instead of
     * a plausible one then cut the rounds fired by seventy per cent and the
     * hits to none: there are five hundred rounds aboard and a gun solution
     * lasts about a second.
     */
    criteria: {
      true: "A burst now would be worth firing: the predicted miss is within a few tens of metres and the rounds are still lethal at that range.",
      false: "A burst now would be thrown away: the predicted miss is hundreds of metres, or the bandit is far beyond lethal range.",
    },
  },
};

export class JevProvider implements ModelProvider {
  readonly id = "jev";

  private readonly model: string;
  private readonly apiKey: string | undefined;
  private lastManeuver: Maneuver | undefined;

  constructor(
    options: ProviderOptions = {},
    private readonly fireConfidence = 0.45,
    private readonly commitConfidence = 0.18,
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
      provider: "jev",
      model: this.model,
      policyVersion: "primitives-3",
      schema: "tactical",
    };
  }

  reset(): void {
    this.lastManeuver = undefined;
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await fetch(env.typesafeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${requireKey(this.apiKey, "TYPESAFE_API_KEY")}`,
      },
      signal,
      body: JSON.stringify({
        model: this.model,
        state: buildBriefing(observation, false),
        questions: QUESTIONS,
      }),
    });
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${await response.text()}`);

    const result = (await response.json()) as SystemOneResponse;
    const answers = result.answers ?? {};
    const maneuver = readChoice(answers["maneuver"], MANEUVERS);
    const commitment = readScore(answers["commitment"], COMMITMENT.length);
    const power = readScore(answers["power"], POWER.length);
    const fire = readNoul(answers["fire"]);

    const committed = maneuver.confidence >= this.commitConfidence || this.lastManeuver === undefined;
    const flying = (committed ? maneuver.choice : this.lastManeuver) as Maneuver;
    this.lastManeuver = flying;

    const targetG = alongScale(COMMITMENT_G, commitment.score);
    const throttleFraction = alongScale(POWER_FRACTION, power.score);

    return {
      distributions: distributionsOf(maneuver, commitment, power, fire),
      action: validateAction({
        schema: "tactical",
        maneuver: flying,
        targetG,
        throttle: nearestDetent(throttleFraction),
        throttleFraction,
        fire: fire >= this.fireConfidence,
      }),
      rationale:
        `${flying} at ${targetG.toFixed(1)} g, ${(throttleFraction * 100).toFixed(0)}% power` +
        `${committed ? "" : " (held: not confident enough to change)"}, shoot ${(fire * 100).toFixed(0)}%`,
      usage: {
        inputTokens: result.usage?.input_tokens ?? 0,
        outputTokens: result.usage?.output_tokens ?? 0,
        costUsd: result.usage?.cost_usd ?? 0,
      },
    };
  }
}
