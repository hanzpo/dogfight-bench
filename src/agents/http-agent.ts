import type { AgentObservation } from "../sim/telemetry";
import { validateDecision, type AgentAdapter, type AgentDecision, type AgentInfo } from "./agent";

/**
 * Turns a failed decision into something worth showing a person.
 *
 * The raw form of this was the status code followed by the server's JSON
 * wrapping the provider's JSON wrapping the provider's own message, which put
 * a brace-filled wall of text across the screen and buried the one fact that
 * mattered -- usually that a key is wrong or an allowance is spent.
 */
async function describeFailure(response: Response, kind: string | undefined): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; needsKey?: boolean };
  const detail = typeof body.error === "string" ? body.error : "";
  const provider = kind ?? "the model";

  // A provider's own rejection arrives wrapped in this server's error string.
  if (/HTTP 401|invalid_api_key|unauthorized/i.test(detail)) {
    return `${provider} rejected that API key. Check it under Model keys.`;
  }
  if (/HTTP 429|rate.?limit/i.test(detail)) return `${provider} is rate limiting these requests.`;
  if (/HTTP 4\d\d/.test(detail) && /insufficient|quota|billing/i.test(detail)) {
    return `That ${provider} account has no credit left.`;
  }
  if (body.needsKey) return detail || `${provider} needs an API key.`;
  if (response.status === 502 && detail) {
    // Keep it to one line: the first sentence is the useful part.
    return `${provider} failed: ${detail.split(/[\n{]/)[0]!.trim().slice(0, 160)}`;
  }
  return detail || `${provider} returned HTTP ${response.status}`;
}

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
    /**
     * Which provider to ask for, and optionally the caller's own credentials.
     *
     * Read fresh on every request rather than captured once, so entering a key
     * mid-match takes effect on the next decision instead of on the next match.
     */
    private readonly kind?: string,
    private readonly headers?: () => Record<string, string>,
  ) {}

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.headers?.() ?? {}) },
      body: JSON.stringify({
        agentId: this.id,
        agent: this.info,
        ...(this.kind ? { kind: this.kind } : {}),
        observation,
      }),
      signal,
    });
    if (!response.ok) throw new Error(await describeFailure(response, this.kind));
    return validateDecision(await response.json());
  }
}
