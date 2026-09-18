import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { validateDecision } from "../src/agents/agent";
import type { AgentObservation } from "../src/sim/telemetry";
import { MatchStore } from "./db";
import { env } from "./env";
import { runSeries, type SeriesRequest } from "./match-runner";
import { SCRIPTED_NAMES, providers } from "./providers";
import { priceOf } from "./pricing";

/**
 * The benchmark server.
 *
 * It owns three things the browser must not: provider credentials, match
 * orchestration, and the results database. The viewer talks to it over HTTP and
 * never sees a key.
 */
const app = new Hono();
const store = new MatchStore();

// The viewer is served by Vite on a different port during development.
app.use("/api/*", cors());

app.get("/api/health", (context) => context.json({ ok: true, version: 2 }));

/** Which entrants this deployment can actually field. */
app.get("/api/agents", (context) => {
  const available = [...providers()].map(([name, provider]) => {
    const info = provider.describe();
    return {
      kind: name,
      available: provider.available(),
      ...info,
      pricing: priceOf(info.model) ?? null,
    };
  });
  const scripted = SCRIPTED_NAMES.map((name) => ({
    kind: name,
    available: true,
    name,
    provider: "scripted",
    model: name,
    policyVersion: "1",
    schema: "tactical" as const,
    pricing: null,
  }));
  return context.json({ agents: [...scripted, ...available] });
});

/**
 * One decision for one aircraft. This is what `HttpAgent` in the browser calls,
 * so a live match in the viewer can be flown by a real model.
 */
app.post("/api/decide", async (context) => {
  const body = (await context.req.json()) as {
    agentId?: string;
    kind?: string;
    observation?: AgentObservation;
  };
  if (!body.observation) return context.json({ error: "observation is required" }, 400);

  const kind = body.kind ?? "anthropic";
  const provider = providers().get(kind);
  if (!provider) return context.json({ error: `Unknown provider "${kind}"` }, 400);
  if (!provider.available()) return context.json({ error: `Provider "${kind}" has no credential` }, 503);

  try {
    const decision = await provider.decide(body.observation);
    return context.json(validateDecision(decision));
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

/** Runs a benchmark series and stores every match. */
app.post("/api/matches", async (context) => {
  const request = (await context.req.json()) as SeriesRequest;
  if (!request?.blue?.kind || !request?.red?.kind) {
    return context.json({ error: "blue.kind and red.kind are required" }, 400);
  }
  try {
    return context.json(
      await runSeries(store, request).then((result) => ({
        wins: result.wins,
        errors: result.errors,
        matches: result.matches.map((match) => ({
          id: match.id,
          winnerId: match.summary.winnerId,
          reason: match.summary.reason,
          durationS: match.summary.durationS,
        })),
      })),
    );
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

app.get("/api/matches", (context) =>
  context.json({ matches: store.listMatches(Number(context.req.query("limit") ?? 50)) }),
);

app.get("/api/matches/:id", (context) => {
  const match = store.getMatch(context.req.param("id"));
  return match ? context.json(match) : context.json({ error: "not found" }, 404);
});

app.get("/api/matches/:id/replay", (context) => {
  const replay = store.getReplay(context.req.param("id"));
  if (!replay) return context.json({ error: "no replay stored for this match" }, 404);
  return new Response(replay, { headers: { "content-type": "application/json" } });
});

app.get("/api/leaderboard", (context) => context.json({ leaderboard: store.leaderboard() }));

if (process.env["NODE_ENV"] !== "test") {
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    const configured = [...providers()]
      .filter(([, provider]) => provider.available())
      .map(([name]) => name);
    console.log(`Dogfight Bench server on http://localhost:${info.port}`);
    console.log(`Providers configured: ${configured.length ? configured.join(", ") : "none (scripted agents only)"}`);
  });
}

export { app, store };
