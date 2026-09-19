import type { AgentObservation } from "../sim/telemetry";
import type { ControlInput } from "../sim/types";
import { validateAction, type AgentAction } from "./action";
import { resolveTacticalForObservation } from "./autopilot";
import { clamp } from "../math";

export interface AgentInfo {
  name: string;
  provider: string;
  model: string;
  policyVersion: string;
  schema: "raw" | "tactical";
}

export interface DecisionUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ChoiceDistribution {
  question: string;
  choice: string;
  confidence: number;
  options: Array<{ id: string; probability: number }>;
}

export interface AgentDecision {
  action: AgentAction;
  rationale?: string;
  usage?: DecisionUsage;
  distributions?: ChoiceDistribution[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly info: AgentInfo;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
  reset?(): void;
}

export const SCRIPTED_INFO = (name: string, schema: "raw" | "tactical" = "tactical"): AgentInfo => ({
  name,
  provider: "scripted",
  model: name,
  policyVersion: "1",
  schema,
});

export function validateDecision(value: unknown): AgentDecision {
  const record = (value ?? {}) as Record<string, unknown>;
  const rationale = record["rationale"];
  const usage = record["usage"] as DecisionUsage | undefined;
  const distributions = validateDistributions(record["distributions"]);
  return {
    action: validateAction(record["action"] ?? record),
    rationale: typeof rationale === "string" ? rationale.slice(0, 2_000) : undefined,
    usage: usage && typeof usage === "object" ? usage : undefined,
    ...(distributions ? { distributions } : {}),
  };
}

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
        return { id: id.slice(0, 48), probability: clamp(probability, 0, 1) };
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
          ? clamp(confidence, 0, 1)
          : (parsed[0]?.probability ?? 0),
      options: parsed,
    });
  }
  return distributions.length ? distributions : undefined;
}

export function resolveAction(action: AgentAction, observation: AgentObservation): ControlInput {
  return resolveTacticalForObservation(action, observation);
}

export class AgentTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Agent did not answer within ${timeoutMs} ms`);
    this.name = "AgentTimeoutError";
    Object.setPrototypeOf(this, AgentTimeoutError.prototype);
  }
}

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
