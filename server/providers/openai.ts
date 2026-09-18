import { MANEUVERS, THROTTLE_DETENTS, validateAction } from "../../src/agents/action";
import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { costUsd } from "../pricing";
import { SYSTEM_PROMPT, buildBriefing } from "../prompt";
import type { ModelProvider, ProviderOptions } from "./types";

/**
 * Any endpoint that speaks the OpenAI chat-completions shape.
 *
 * Pointing `OPENAI_BASE_URL` at OpenAI, Groq, OpenRouter, Together, vLLM or a
 * local Ollama is the whole configuration, so the benchmark is not limited to
 * the providers that happen to have a first-party SDK here.
 */
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reasoning", "maneuver", "targetG", "throttle", "fire"],
  properties: {
    reasoning: { type: "string", description: "One sentence on the tactical picture." },
    maneuver: { type: "string", enum: [...MANEUVERS] },
    targetG: { type: "number", minimum: 1, maximum: 9 },
    throttle: { type: "string", enum: [...THROTTLE_DETENTS] },
    fire: { type: "boolean" },
  },
} as const;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = "openai";

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model ?? env.openaiModel;
    this.baseUrl = options.baseUrl ?? env.openaiBaseUrl;
    this.apiKey = options.apiKey ?? env.openaiApiKey;
  }

  available(): boolean {
    // A local endpoint such as Ollama needs no key.
    return Boolean(this.apiKey) || !this.baseUrl.includes("api.openai.com");
  }

  describe(): AgentInfo {
    return {
      name: `openai-compatible/${this.model}`,
      provider: "openai",
      model: this.model,
      policyVersion: "bfm-briefing-2",
      schema: "tactical",
    };
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.baseUrl.includes("api.openai.com")) {
      headers["authorization"] = `Bearer ${requireKey(this.apiKey, "OPENAI_API_KEY")}`;
    } else if (this.apiKey) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 700,
        response_format: {
          type: "json_schema",
          json_schema: { name: "dogfight_action", strict: true, schema: JSON_SCHEMA },
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildBriefing(observation) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`${this.baseUrl} returned HTTP ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as ChatCompletion;
    if (body.error) throw new Error(body.error.message ?? "provider error");

    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Model returned no content");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error("Model returned content that was not JSON");
    }

    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    return {
      action: validateAction({ schema: "tactical", ...parsed }),
      rationale: typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : undefined,
      usage: { inputTokens, outputTokens, costUsd: costUsd(this.model, inputTokens, outputTokens) },
    };
  }
}
