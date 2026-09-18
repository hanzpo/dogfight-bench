import { EnergyFighterAgent, BasicPursuitAgent } from "../../src/agents/baselines";
import type { AgentAdapter } from "../../src/agents/agent";
import { AnthropicProvider } from "./anthropic";
import { JevProvider } from "./jev";
import { OpenAiCompatibleProvider } from "./openai";
import type { ModelProvider, ProviderOptions } from "./types";

export type { ModelProvider, ProviderOptions };

/**
 * Providers, keyed by the name used in the API and on the leaderboard.
 *
 * Optionally built around credentials supplied by the caller instead of the
 * server's own, which is how someone brings their own key: the provider is
 * constructed for that one request and discarded with it.
 */
export function providers(options: ProviderOptions = {}): Map<string, ModelProvider> {
  return new Map<string, ModelProvider>([
    ["anthropic", new AnthropicProvider(options)],
    ["openai", new OpenAiCompatibleProvider(options)],
    ["jev", new JevProvider(options)],
    /**
     * The same model flying the same aircraft through the other interface.
     *
     * Listed as its own entrant rather than hidden behind a setting, because
     * that is what it is: a different pilot with its own rating. Naming it in
     * the picker is also the only way somebody discovers the comparison exists.
     */
    ["jev-stick", new JevProvider({ ...options, schema: "raw" })],
  ]);
}

/** Wraps a provider as an agent the simulation can attach. */
export function providerAgent(id: string, provider: ModelProvider): AgentAdapter {
  return {
    id,
    info: provider.describe(),
    decide: (observation, signal) => provider.decide(observation, signal),
  };
}

/** Scripted opponents, available without any credential. */
export function scriptedAgent(name: string, id: string): AgentAdapter | undefined {
  if (name === "energy-fighter") return new EnergyFighterAgent(id);
  if (name === "basic-pursuit") return new BasicPursuitAgent(id);
  return undefined;
}

export const SCRIPTED_NAMES = ["energy-fighter", "basic-pursuit"] as const;
