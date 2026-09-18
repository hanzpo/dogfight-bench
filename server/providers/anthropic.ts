import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MANEUVERS, THROTTLE_DETENTS, validateAction } from "../../src/agents/action";
import type { AgentDecision, AgentInfo } from "../../src/agents/agent";
import type { AgentObservation } from "../../src/sim/telemetry";
import { env, requireKey } from "../env";
import { costUsd } from "../pricing";
import { SYSTEM_PROMPT, buildBriefing } from "../prompt";
import type { ModelProvider, ProviderOptions } from "./types";

/**
 * Claude as a fighter pilot.
 *
 * The action is requested as a structured output rather than parsed out of
 * prose, so a malformed decision is a provider error rather than a silent
 * misflown manoeuvre. Effort defaults to low because the decision loop runs
 * about once a second; raise it and raise `DECISION_INTERVAL_S` to match.
 */
const DecisionSchema = z.object({
  reasoning: z.string().describe("One sentence: the tactical picture and why this manoeuvre."),
  maneuver: z.enum(MANEUVERS),
  targetG: z.number().min(1).max(9).describe("Load factor to pull, 1 to 9."),
  throttle: z.enum(THROTTLE_DETENTS),
  fire: z.boolean().describe("Squeeze the trigger this second."),
});

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  private client?: Anthropic;

  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(options: ProviderOptions = {}) {
    this.model = options.model ?? env.anthropicModel;
    this.apiKey = options.apiKey ?? env.anthropicApiKey;
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  describe(): AgentInfo {
    return {
      name: `claude/${this.model}`,
      provider: "anthropic",
      model: this.model,
      policyVersion: "bfm-briefing-1",
      schema: "tactical",
    };
  }

  private sdk(): Anthropic {
    this.client ??= new Anthropic({ apiKey: requireKey(this.apiKey, "ANTHROPIC_API_KEY") });
    return this.client;
  }

  async decide(observation: AgentObservation, signal?: AbortSignal): Promise<AgentDecision> {
    const response = await this.sdk().messages.parse(
      {
        model: this.model,
        max_tokens: 2_000,
        system: SYSTEM_PROMPT,
        output_config: {
          format: zodOutputFormat(DecisionSchema),
          effort: env.anthropicEffort,
        },
        messages: [{ role: "user", content: buildBriefing(observation) }],
      },
      { signal },
    );

    if (response.stop_reason === "refusal") {
      throw new Error(`Model declined: ${response.stop_details?.category ?? "unknown"}`);
    }
    const parsed = response.parsed_output;
    if (!parsed) throw new Error("Model returned no parseable decision");

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      action: validateAction({ schema: "tactical", ...parsed }),
      rationale: parsed.reasoning,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: costUsd(this.model, inputTokens, outputTokens),
      },
    };
  }
}
