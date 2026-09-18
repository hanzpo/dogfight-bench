import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";

export interface ProviderOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export interface ModelProvider {
  readonly id: string;
  available(): boolean;
  describe(): AgentInfo;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
}
