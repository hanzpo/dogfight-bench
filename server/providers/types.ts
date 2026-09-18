import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";

/**
 * A model provider.
 *
 * Adding a provider means implementing this and registering it. Nothing about
 * the simulation, the action schema or the scoring changes, which is what makes
 * results across providers comparable.
 */
/**
 * Credentials for one request.
 *
 * A key that arrives here came from the person using the page, and it is used
 * to make exactly one call and then dropped. It is never written to the
 * database, never logged, and never becomes the server's own credential -- so a
 * provider must read it from the object it was constructed with rather than
 * from the environment, which is why every provider takes this rather than
 * reaching for `env` itself.
 */
export interface ProviderOptions {
  apiKey?: string | undefined;
  model?: string | undefined;
  /** Only meaningful for the OpenAI-compatible provider. */
  baseUrl?: string | undefined;
}

export interface ModelProvider {
  readonly id: string;
  /** False when the provider's credential is missing, so it can be listed as unavailable. */
  available(): boolean;
  describe(): AgentInfo;
  decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision>;
}
