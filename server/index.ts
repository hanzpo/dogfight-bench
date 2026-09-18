import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** True when this process is reachable from somewhere other than this machine. */
const exposed = env.host !== "127.0.0.1" && env.host !== "localhost";

/**
 * Cross-origin access is off unless origins are named explicitly.
 *
 * In development the viewer reaches the API through Vite's proxy, so it is
 * already same-origin; in production this process serves the viewer itself. A
 * blanket `cors()` only ever helps somebody else's page call this one.
 */
if (env.allowedOrigins.length) {
  app.use("/api/*", cors({ origin: env.allowedOrigins }));
}

/**
 * Guards the endpoints that spend money.
 *
 * Everything else -- the leaderboard, match history, replays -- is read-only
 * and public. These two call paid providers on this server's credentials.
 */
const requireToken = async (
  context: { req: { header: (name: string) => string | undefined } },
  next: () => Promise<void>,
) => {
  if (env.apiToken) {
    const offered = context.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (offered !== env.apiToken) {
      return new Response(JSON.stringify({ error: "unauthorised" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return next();
  }
  if (exposed) {
    return new Response(
      JSON.stringify({
        error: "This endpoint spends provider credits. Set DOGFIGHT_API_TOKEN to expose it.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return next();
};

app.use("/api/decide", requireToken);
app.use("/api/matches", async (context, next) =>
  context.req.method === "POST" ? requireToken(context, next) : next(),
);

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
  // Validate the shape before handing it to a provider: an adapter reaching
  // into a malformed observation produces a 502 with an internal message, which
  // is both confusing and more than a caller should be told.
  const observation = body.observation;
  if (
    !observation ||
    !Array.isArray(observation.aircraft) ||
    observation.aircraft.length < 2 ||
    !observation.relative ||
    typeof observation.ownshipId !== "string"
  ) {
    return context.json({ error: "a complete observation is required" }, 400);
  }

  const kind = body.kind ?? "anthropic";
  const provider = providers().get(kind);
  if (!provider) return context.json({ error: `Unknown provider "${kind}"` }, 400);
  if (!provider.available()) return context.json({ error: `Provider "${kind}" has no credential` }, 503);

  try {
    const decision = await provider.decide(observation);
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
  // One request must not be able to queue an unbounded amount of paid work.
  if ((request.rounds ?? 3) > env.maxSeriesRounds) {
    return context.json({ error: `rounds may not exceed ${env.maxSeriesRounds}` }, 400);
  }
  if (running) return context.json({ error: "a series is already running" }, 429);
  running = true;
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
  } finally {
    running = false;
  }
});

/** Only one benchmark series at a time; they are long and they cost money. */
let running = false;

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

/**
 * Serve the built viewer, so a deployment is one process rather than two.
 *
 * Unknown paths fall through to the app shell because the viewer is a
 * client-routed single page: reloading on /leaderboard must not 404.
 */
const indexPath = join(env.staticDir, "index.html");
if (existsSync(indexPath)) {
  app.use("/*", serveStatic({ root: env.staticDir }));
  const shell = readFileSync(indexPath, "utf8");
  app.notFound((context) =>
    context.req.path.startsWith("/api/")
      ? context.json({ error: "not found" }, 404)
      : context.html(shell),
  );
}

if (process.env["NODE_ENV"] !== "test") {
  serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    const configured = [...providers()]
      .filter(([, provider]) => provider.available())
      .map(([name]) => name);
    console.log(`Dogfight Bench server on http://${env.host}:${info.port}`);
    console.log(`Viewer: ${existsSync(indexPath) ? `served from ${env.staticDir}` : "not built (run npm run build)"}`);
    console.log(`Providers: ${configured.length ? configured.join(", ") : "none (scripted agents only)"}`);
    if (exposed && !env.apiToken && configured.length) {
      console.warn(
        "WARNING: bound to a public interface with providers configured and no DOGFIGHT_API_TOKEN.\n" +
          "         Paid endpoints are disabled. Set DOGFIGHT_API_TOKEN to enable them.",
      );
    }
  });
}

export { app, store };
