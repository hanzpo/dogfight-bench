import type { AgentObservation } from "../sim/telemetry";
import { validateDecision, type AgentAdapter, type AgentDecision, type AgentInfo } from "./agent";

/**
 * Talks to a model through the benchmark's own server.
 *
 * Provider credentials, prompt construction and response parsing all live
 * behind this endpoint, which is what keeps API keys out of the browser bundle
 * and lets every provider be added without touching the simulation.
 */
export class HttpAgent implements AgentAdapter {
  constructor(
    public readonly id: string,
    readonly info: AgentInfo,
    private readonly endpoint: string,
  ) {}

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: this.id, agent: this.info, observation }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Agent ${this.id} returned HTTP ${response.status}: ${await response.text()}`);
    }
    return validateDecision(await response.json());
  }
}
