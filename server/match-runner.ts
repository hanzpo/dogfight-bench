import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "../src/agents/agent";
import { ReplayRecorder } from "../src/sim/replay";
import { neutralMerge, scenarioSet } from "../src/sim/scenario";
import { DogfightSimulation, type MatchSummary } from "../src/sim/simulation";
import type { ScenarioConfig } from "../src/sim/types";
import { competitorFor, type ResultsStore } from "./store";
import { env } from "./env";
import { providerAgent, providers, scriptedAgent } from "./providers";

/**
 * Runs benchmark matches headlessly and stores the results.
 *
 * Every match runs through `runHeadless`, so neither model gets extra simulated
 * time for being slow and the recorded decision log reproduces the match
 * exactly. A series runs the same seeded scenario ladder for both entrants and
 * swaps sides, because a single symmetric merge mostly measures who happened to
 * win the first pass.
 */

export interface Entrant {
  /** A provider name ("anthropic", "openai", "jev") or a scripted agent name. */
  kind: string;
}

export interface SeriesRequest {
  blue: Entrant;
  red: Entrant;
  /** Number of scenario variants; each is flown twice with sides swapped. */
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
    // Run here, from the decision log, so it reproduces exactly.
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
    // Fly each scenario both ways round so a side advantage cannot decide it.
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
