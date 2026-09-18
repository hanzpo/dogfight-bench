import { EnergyFighterAgent, BasicPursuitAgent } from "../../src/agents/baselines";
import type { AgentAdapter } from "../../src/agents/agent";
import { AnthropicProvider } from "./anthropic";
import { JevProvider } from "./jev";
import { OpenAiCompatibleProvider } from "./openai";
import type { ModelProvider } from "./types";

export type { ModelProvider };

/** Providers, keyed by the name used in the API and on the leaderboard. */
export function providers(): Map<string, ModelProvider> {
  return new Map<string, ModelProvider>([
    ["anthropic", new AnthropicProvider()],
    ["openai", new OpenAiCompatibleProvider()],
    ["jev", new JevProvider()],
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
