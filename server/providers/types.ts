import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";

/**
 * A model provider.
 *
 * Adding a provider means implementing this and registering it. Nothing about
 * the simulation, the action schema or the scoring changes, which is what makes
 * results across providers comparable.
 */
export interface ModelProvider {
  readonly id: string;
  /** False when the provider's credential is missing, so it can be listed as unavailable. */
  available(): boolean;
  describe(): AgentInfo;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
}
