import type { AgentAdapter, AgentDecision } from "./agent";
import { validateDecision } from "./agent";
import type { AgentObservation } from "../sim/telemetry";

/**
 * Model-neutral adapter. A server endpoint keeps provider keys out of the browser
 * and translates Jev or an autoregressive LLM into the benchmark action schema.
 */
export class HttpAgent implements AgentAdapter {
  constructor(public readonly id: string, private readonly endpoint: string) {}

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: this.id, observation }),
      signal,
    });
    if (!response.ok) throw new Error(`Agent ${this.id} returned HTTP ${response.status}`);
    return validateDecision(await response.json() as AgentDecision);
  }
}
