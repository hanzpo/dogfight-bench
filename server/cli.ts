import { createStore } from "./store";
import { runSeries } from "./match-runner";
import { providers, SCRIPTED_NAMES } from "./providers";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const blue = argument("blue", "energy-fighter")!;
const red = argument("red", "basic-pursuit")!;
const rounds = Number(argument("rounds", "3"));
const maxTimeS = Number(argument("max-time", "180"));

const known = [...SCRIPTED_NAMES, ...providers().keys()];
for (const entrant of [blue, red]) {
  if (!known.includes(entrant)) {
    console.error(`Unknown entrant "${entrant}". Available: ${known.join(", ")}`);
    process.exit(1);
  }
}

const store = createStore();
console.log(`Running ${rounds} scenarios, both sides, ${blue} vs ${red}...`);

const result = await runSeries(store, {
  blue: { kind: blue },
  red: { kind: red },
  rounds,
  maxTimeS,
});

for (const match of result.matches) {
  const summary = match.summary;
  console.log(
    `  ${summary.scenarioId}: ${summary.winnerId ?? "draw"} (${summary.reason}) after ${summary.durationS.toFixed(0)}s`,
  );
}
for (const error of result.errors) console.error(`  error: ${error}`);

console.log("\nLeaderboard:");
for (const row of await store.leaderboard(["model", "scripted", "human"])) {
  console.log(
    `  ${row.rating.toFixed(0).padStart(5)}  ${row.name.padEnd(24)} ` +
      `${row.policyVersion.padEnd(18)}` +
      `${row.wins}W-${row.losses}L-${row.draws}D  ` +
      `acc ${(row.accuracy * 100).toFixed(1)}%  ` +
      `on-target ${row.timeOnTargetS.toFixed(1)}s  ` +
      `$${row.costUsd.toFixed(4)} (${row.avgLatencyMs.toFixed(0)} ms/decision)`,
  );
}
store.close();
