import type { AgentObservation } from "../sim/telemetry";
import { validateDecision, type AgentAdapter, type AgentDecision, type AgentInfo } from "./agent";

async function describeFailure(response: Response, kind: string | undefined): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; needsKey?: boolean };
  const detail = typeof body.error === "string" ? body.error : "";
  const provider = kind ?? "the model";

  if (/HTTP 401|invalid_api_key|unauthorized/i.test(detail)) {
    return `${provider} rejected that API key. Check it under Model keys.`;
  }
  if (/HTTP 429|rate.?limit/i.test(detail)) return `${provider} is rate limiting these requests.`;
  if (/HTTP 4\d\d/.test(detail) && /insufficient|quota|billing/i.test(detail)) {
    return `That ${provider} account has no credit left.`;
  }
  if (body.needsKey) return detail || `${provider} needs an API key.`;
  if (response.status === 502 && detail) {
    return `${provider} failed: ${detail.split(/[\n{]/)[0]!.trim().slice(0, 160)}`;
  }
  return detail || `${provider} returned HTTP ${response.status}`;
}

export class HttpAgent implements AgentAdapter {
  constructor(
    public readonly id: string,
    readonly info: AgentInfo,
    private readonly endpoint: string,
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
