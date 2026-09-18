import type { ControlInput } from "../sim/types";
import type { AgentObservation } from "../sim/telemetry";

export interface AgentDecision {
  controls: ControlInput;
  rationale?: string;
}

/** API adapters for Jev and autoregressive LLMs implement this identical contract. */
export interface AgentAdapter {
  readonly id: string;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
}

export function validateDecision(value: AgentDecision): AgentDecision {
  const finite = (n: unknown, fallback: number) => typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return {
    controls: {
      pitch: Math.max(-1, Math.min(1, finite(value?.controls?.pitch, 0))),
      roll: Math.max(-1, Math.min(1, finite(value?.controls?.roll, 0))),
      yaw: Math.max(-1, Math.min(1, finite(value?.controls?.yaw, 0))),
      throttle: Math.max(0, Math.min(1, finite(value?.controls?.throttle, 0.85))),
      fire: value?.controls?.fire === true,
    },
    rationale: typeof value?.rationale === "string" ? value.rationale.slice(0, 500) : undefined,
  };
}
