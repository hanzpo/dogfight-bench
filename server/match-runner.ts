import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../src/agents/agent";
import { ReplayRecorder } from "../src/sim/replay";
import { neutralMerge, scenarioSet } from "../src/sim/scenario";
import { DogfightSimulation, type MatchSummary } from "../src/sim/simulation";
import type { ScenarioConfig } from "../src/sim/types";
import { competitorFor, type ResultsStore } from "./store";
import { env } from "./env";
import { providerAgent, providers, scriptedAgent } from "./providers";

export interface Entrant {
  kind: string;
}

export interface SeriesRequest {
  blue: Entrant;
  red: Entrant;
  rounds?: number;
  maxTimeS?: number;
  decisionIntervalS?: number;
  storeReplays?: boolean;
}

export interface SeriesResult {
  matches: Array<{ id: string; summary: MatchSummary }>;
  wins: Record<string, number>;
  errors: string[];
}

function buildAgent(kind: string, aircraftId: string): AgentAdapter {
  const scripted = scriptedAgent(kind, aircraftId);
  if (scripted) return scripted;

  const provider = providers().get(kind);
  if (!provider) throw new Error(`Unknown entrant "${kind}"`);
  if (!provider.available()) throw new Error(`Provider "${kind}" has no credential configured`);
  return providerAgent(aircraftId, provider);
}

export async function runMatch(
  store: ResultsStore,
  scenario: ScenarioConfig,
  blue: Entrant,
  red: Entrant,
  options: { storeReplay?: boolean; decisionIntervalS?: number } = {},
): Promise<{ id: string; summary: MatchSummary }> {
  const blueAgent = buildAgent(blue.kind, "blue-1");
  const redAgent = buildAgent(red.kind, "red-1");

  const simulation = new DogfightSimulation(scenario, {
    decisionIntervalS: options.decisionIntervalS ?? env.decisionIntervalS,
    decisionTimeoutMs: env.decisionTimeoutMs,
    inferenceBudgetUsd: env.inferenceBudgetUsd,
  });
  simulation.attachAgent("blue-1", blueAgent);
  simulation.attachAgent("red-1", redAgent);

  const agents = { "blue-1": blueAgent.info, "red-1": redAgent.info };
  const recorder = new ReplayRecorder(scenario, agents);
  await simulation.runHeadless((state) => recorder.capture(state));

  const summary = simulation.summary();
  recorder.finish(simulation.decisions, summary);

  const id = randomUUID();
  await store.recordMatch({
    id,
    summary,
    competitors: {
      "blue-1": competitorFor(blueAgent.info),
      "red-1": competitorFor(redAgent.info),
    },
    origin: "headless",
    verified: true,
    replayJson: options.storeReplay === false ? undefined : recorder.toJSON(),
  });
  return { id, summary };
}

export async function runSeries(store: ResultsStore, request: SeriesRequest): Promise<SeriesResult> {
  const rounds = Math.max(1, Math.min(request.rounds ?? 3, 50));
  const base: ScenarioConfig = { ...neutralMerge, maxTime: request.maxTimeS ?? neutralMerge.maxTime };
  const scenarios = scenarioSet(rounds, base);

  const matches: SeriesResult["matches"] = [];
  const wins: Record<string, number> = {};
  const errors: string[] = [];

  for (const scenario of scenarios) {
    for (const [blue, red] of [
      [request.blue, request.red],
      [request.red, request.blue],
    ] as const) {
      try {
        const match = await runMatch(store, scenario, blue, red, {
          storeReplay: request.storeReplays,
          decisionIntervalS: request.decisionIntervalS,
        });
        matches.push(match);
        const winner = match.summary.winnerId
          ? match.summary.agents[match.summary.winnerId]?.info?.name ?? match.summary.winnerId
          : "draw";
        wins[winner] = (wins[winner] ?? 0) + 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return { matches, wins, errors };
}
