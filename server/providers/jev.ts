import { MANEUVERS, validateAction, type Maneuver } from "../../src/agents/action";
import type { AgentDecision, AgentInfo, ChoiceDistribution } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { MANEUVER_GUIDE, buildBriefing } from "../prompt";
import type { ModelProvider, ProviderOptions } from "./types";

/**
 * Jev, through TypeSafe's System One endpoint.
 *
 * Jev is not a model that writes an answer. It evaluates typed questions
 * against a state and returns the answer already shaped, with a probability
 * distribution and a calibrated confidence attached. There are three kinds of
 * question and this uses all three, because a dogfight asks all three kinds:
 *
 *   `choice` for the manoeuvre -- one of thirteen named things to do.
 *   `score`  for how hard to pull and how much power to use. A score is a
 *            position on a rubric, returned as a probability-weighted mean, so
 *            the answer is continuous. Asking these as a choice would quantise
 *            a control axis into five buckets and throw away everything the
 *            model knew between them.
 *   `noul`   for the trigger, which is a yes/no question whose honest answer is
 *            a probability rather than a verdict.
 *
 * Every question is evaluated in parallel against the same state in one
 * request, so the whole decision is one round trip of about two hundred
 * milliseconds.
 *
 * The state is the same tactical picture the briefing gives every other
 * provider. That is deliberate: two models answering differently about the same
 * situation is the comparison worth making; two models reading different
 * situations is not.
 */

/**
 * How hard to pull, as a rubric rather than a menu.
 *
 * Each question is evaluated in isolation against the state, so this cannot
 * refer to the manoeuvre the other question picked. It is phrased instead as a
 * judgement the state alone can settle: how much of the aircraft's turning
 * capability the situation is worth spending right now.
 */
const COMMITMENT = [
  "Unload, about 1 g. Speed is the problem, or the bandit is far enough away that pointing costs nothing.",
  "About 3 g. A gentle correction: the picture is nearly right and does not need forcing.",
  "About 5 g, the sustained rate. As hard as this jet can turn without going backwards on energy.",
  "About 7 g. Harder than it can sustain, accepting the speed loss, because the angles are worth more.",
  "9 g, on the limiter. Maximum instantaneous turn -- a guns defence, or the last few degrees to a shot.",
] as const;

/** How much thrust the situation is asking for, judged from the state alone. */
const POWER = [
  "Idle. Closing far too fast, or about to overshoot, and the closure has to stop.",
  "Around a third. A little fast for the turn being flown; less power settles it.",
  "About half -- enough to hold the current speed and spend nothing extra.",
  "Military power, full dry thrust, because speed is needed or is being lost.",
  "Afterburner, everything the engine has, to run, to climb, or to hold a hard turn.",
] as const;

/** Load factor the ends of the commitment rubric mean. */
const MIN_G = 1;
const MAX_G = 9;

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

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const probability = (value: unknown) => finite(value) && (value as number) >= 0 && (value as number) <= 1;

/**
 * Nothing malformed becomes an action.
 *
 * A decision that cannot be trusted is a provider error, counted against the
 * model, rather than a silently misflown manoeuvre that looks like bad piloting.
 */
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
  if (!valid) throw new Error("Invalid TypeSafe choice; no action taken");
  return answer;
}

function readScore(value: unknown, levels: number): ScoreAnswer {
  const answer = value as ScoreAnswer | undefined;
  const valid =
    answer !== undefined &&
    finite(answer.score) &&
    answer.score >= 0 &&
    answer.score <= levels - 1 &&
    probability(answer.confidence);
  if (!valid) throw new Error("Invalid TypeSafe score; no action taken");
  return answer;
}

function readNoul(value: unknown): number {
  const answer = value as NoulAnswer | undefined;
  if (!answer || !probability(answer.noul)) throw new Error("Invalid TypeSafe noul; no action taken");
  return answer.noul;
}

/** Turns each answer into the distribution the observer panel draws. */
function distributionsOf(
  maneuver: ChoiceAnswer,
  commitment: ScoreAnswer,
  power: ScoreAnswer,
  fire: number,
): ChoiceDistribution[] {
  const fromScore = (question: string, answer: ScoreAnswer, rubric: readonly string[]): ChoiceDistribution => ({
    question,
    // The level it landed nearest, named, so a number on a rubric reads as a
    // decision rather than as a coordinate.
    choice: rubric[Math.round(answer.score)]?.split(".")[0] ?? answer.score.toFixed(2),
    confidence: answer.confidence,
    options: Object.entries(answer.probabilities ?? {})
      .map(([level, value]) => ({
        id: (answer.legend?.[level] ?? rubric[Number(level)] ?? level).split(".")[0]!,
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

export class JevProvider implements ModelProvider {
  readonly id = "jev";

  private readonly model: string;
  private readonly apiKey: string | undefined;
  /** The manoeuvre being flown, kept so a low-confidence answer can be ignored. */
  private lastManeuver: Maneuver | undefined;

  constructor(
    options: ProviderOptions = {},
    /** Fire only when the model is actually confident, not merely past a half. */
    private readonly fireConfidence = 0.6,
    /**
     * Below this, the previous manoeuvre is held.
     *
     * Confidence is a second axis to decide on, and thrashing between plans
     * every second is worse flying than committing to one. If the model is not
     * sure, it has not found a reason to change its mind.
     */
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
      policyVersion: "primitives-1",
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
        questions: {
          maneuver: {
            type: "choice",
            instructions: "Which manoeuvre should the pilot fly for the next few seconds?",
            criteria: Object.fromEntries(MANEUVERS.map((name) => [name, MANEUVER_GUIDE[name]])),
          },
          commitment: {
            type: "score",
            instructions: "How hard should the pilot pull through that manoeuvre?",
            criteria: [...COMMITMENT],
          },
          power: {
            type: "score",
            instructions: "How much thrust should the pilot be carrying?",
            criteria: [...POWER],
          },
          fire: {
            type: "noul",
            instructions: "Would a burst fired right now hit the bandit?",
            criteria: {
              true: "The nose is on the lead point, the bandit is inside lethal range, and the predicted miss is small.",
              false: "The aim is off, the bandit is out of range, or the rounds would arrive where it no longer is.",
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${await response.text()}`);

    const result = (await response.json()) as SystemOneResponse;
    const answers = result.answers ?? {};
    const maneuver = readChoice(answers["maneuver"], MANEUVERS);
    const commitment = readScore(answers["commitment"], COMMITMENT.length);
    const power = readScore(answers["power"], POWER.length);
    const fire = readNoul(answers["fire"]);

    // Confidence-gated: a guess does not get to change the plan mid-fight.
    const committed = maneuver.confidence >= this.commitConfidence || this.lastManeuver === undefined;
    const flying = (committed ? maneuver.choice : this.lastManeuver) as Maneuver;
    this.lastManeuver = flying;

    const targetG = MIN_G + (commitment.score / (COMMITMENT.length - 1)) * (MAX_G - MIN_G);
    const throttleFraction = power.score / (POWER.length - 1);

    return {
      distributions: distributionsOf(maneuver, commitment, power, fire),
      action: validateAction({
        schema: "tactical",
        maneuver: flying,
        targetG,
        // The fraction is what is flown; the detent is the nearest name for it,
        // kept so anything reading the action without knowing about fractions
        // still sees something sensible.
        throttle: throttleFraction > 0.92 ? "ab" : throttleFraction > 0.7 ? "mil" : throttleFraction > 0.3 ? "cruise" : "idle",
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
