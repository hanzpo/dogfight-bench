import type { AgentObservation } from "../sim/telemetry";
import type { ControlInput } from "../sim/types";
import { validateAction, type AgentAction } from "./action";
import { resolveTacticalForObservation } from "./autopilot";

/**
 * The model-neutral agent boundary.
 *
 * Everything that flies an aircraft in this benchmark implements this, whether
 * it is a scripted baseline, a language model behind an HTTP endpoint, or a
 * low-level controller. The contract is deliberately narrow: one observation
 * in, one action out, with metadata attached so a result can be attributed to
 * a specific model version at a specific price.
 */

export interface AgentInfo {
  /** Human-readable name shown on the leaderboard. */
  name: string;
  /** Who runs the model: "scripted", "anthropic", "openai", "jev", ... */
  provider: string;
  /** Exact model identifier, so a result is reproducible and attributable. */
  model: string;
  /** Version of the agent's own prompt or policy, independent of the model. */
  policyVersion: string;
  /** Which action schema this agent speaks. */
  schema: "raw" | "tactical";
}

export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cost of this single decision in US dollars. */
  costUsd?: number;
}

/**
 * A calibrated distribution over one question's options.
 *
 * Most models return an answer and nothing else. Some return how sure they are
 * of each alternative, which is strictly more information than the answer: a
 * manoeuvre chosen at 0.31 against a field of twelve is a guess, and the same
 * manoeuvre at 0.94 is a conviction, and a benchmark that shows only the choice
 * cannot tell those apart. Optional, because nothing may assume it exists.
 */
export interface ChoiceDistribution {
  /** What was asked: "maneuver", "target_g", "throttle", "fire". */
  question: string;
  /** The option that won. */
  choice: string;
  confidence: number;
  /** Every option and its probability, highest first. */
  options: Array<{ id: string; probability: number }>;
}

export interface AgentDecision {
  action: AgentAction;
  rationale?: string;
  usage?: DecisionUsage;
  /** Present only for models that report calibrated probabilities. */
  distributions?: ChoiceDistribution[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly info: AgentInfo;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
  /** Called between matches so an agent can drop per-match conversation state. */
  reset?(): void;
}

export const SCRIPTED_INFO = (name: string, schema: "raw" | "tactical" = "tactical"): AgentInfo => ({
  name,
  provider: "scripted",
  model: name,
  policyVersion: "1",
  schema,
});

/** Coerces any decision into a valid one; never throws. */
export function validateDecision(value: unknown): AgentDecision {
  const record = (value ?? {}) as Record<string, unknown>;
  const rationale = record["rationale"];
  const usage = record["usage"] as DecisionUsage | undefined;
  const distributions = validateDistributions(record["distributions"]);
  return {
    // Accept a bare action, or a decision wrapping one.
    action: validateAction(record["action"] ?? record),
    rationale: typeof rationale === "string" ? rationale.slice(0, 2_000) : undefined,
    usage: usage && typeof usage === "object" ? usage : undefined,
    ...(distributions ? { distributions } : {}),
  };
}

/**
 * Coerces reported probabilities into something safe to render.
 *
 * Bounded in every dimension, because this crosses the network from a model's
 * response and ends up on screen sixty times a second. A provider that returns
 * ten thousand options must not be able to make the page unusable, and one that
 * returns nonsense must produce no distribution rather than a broken one.
 */
function validateDistributions(value: unknown): ChoiceDistribution[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const distributions: ChoiceDistribution[] = [];
  for (const entry of value.slice(0, 8)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const question = record["question"];
    const choice = record["choice"];
    const options = record["options"];
    if (typeof question !== "string" || typeof choice !== "string" || !Array.isArray(options)) continue;

    const parsed = options
      .slice(0, 32)
      .map((option) => {
        const fields = (option ?? {}) as Record<string, unknown>;
        const id = fields["id"];
        const probability = fields["probability"];
        if (typeof id !== "string" || typeof probability !== "number" || !Number.isFinite(probability)) {
          return undefined;
        }
        return { id: id.slice(0, 48), probability: Math.max(0, Math.min(1, probability)) };
      })
      .filter((option): option is { id: string; probability: number } => option !== undefined)
      .sort((a, b) => b.probability - a.probability);
    if (!parsed.length) continue;

    const confidence = record["confidence"];
    distributions.push({
      question: question.slice(0, 48),
      choice: choice.slice(0, 48),
      confidence:
        typeof confidence === "number" && Number.isFinite(confidence)
          ? Math.max(0, Math.min(1, confidence))
          : (parsed[0]?.probability ?? 0),
      options: parsed,
    });
  }
  return distributions.length ? distributions : undefined;
}

/** Turns an action of either schema into the stick and throttle the jet flies. */
export function resolveAction(action: AgentAction, observation: AgentObservation): ControlInput {
  return action.schema === "raw" ? action.controls : resolveTacticalForObservation(action, observation);
}

export class AgentTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Agent did not answer within ${timeoutMs} ms`);
    this.name = "AgentTimeoutError";
    Object.setPrototypeOf(this, AgentTimeoutError.prototype);
  }
}

/**
 * Enforces a decision deadline.
 *
 * A model that thinks for ten seconds has not earned ten seconds of simulated
 * time to think in, so the deadline is part of the benchmark rather than a
 * convenience. The abort signal is passed through so an adapter can cancel the
 * underlying request instead of leaking it.
 */
export async function decideWithTimeout(
  agent: AgentAdapter,
  observation: AgentObservation,
  timeoutMs: number,
): Promise<AgentDecision> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return agent.decide(observation);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the race before aborting. An adapter that honours the signal
      // rejects the instant it is aborted, and if that lands first the miss
      // gets recorded as an ordinary failure rather than a timeout.
      reject(new AgentTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([agent.decide(observation, controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
