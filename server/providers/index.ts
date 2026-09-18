import { EnergyFighterAgent, BasicPursuitAgent } from "../../src/agents/baselines";
import type { AgentAdapter } from "../../src/agents/agent";
import { AnthropicProvider } from "./anthropic";
import { JevProvider } from "./jev";
import { OpenAiCompatibleProvider } from "./openai";
import type { ModelProvider, ProviderOptions } from "./types";

export type { ModelProvider, ProviderOptions };

export function providers(options: ProviderOptions = {}): Map<string, ModelProvider> {
  return new Map<string, ModelProvider>([
    ["anthropic", new AnthropicProvider(options)],
    ["openai", new OpenAiCompatibleProvider(options)],
    ["jev", new JevProvider(options)],
  ]);
}

export function providerAgent(id: string, provider: ModelProvider): AgentAdapter {
  return {
    id,
    info: provider.describe(),
    // Forwarded, or a provider that carries state between decisions -- Jev holds
    // the last manoeuvre when its confidence is low -- starts the second match
    // of a series flying the end of the first.
    reset: () => provider.reset?.(),
    decide: (observation, signal) => provider.decide(observation, signal),
  };
}

export function scriptedAgent(name: string, id: string): AgentAdapter | undefined {
  if (name === "energy-fighter") return new EnergyFighterAgent(id);
  if (name === "basic-pursuit") return new BasicPursuitAgent(id);
  return undefined;
}

export const SCRIPTED_NAMES = ["energy-fighter", "basic-pursuit"] as const;
