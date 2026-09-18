import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { validateDecision } from "../src/agents/agent";
import type { MatchSummary } from "../src/sim/simulation";
import type { AgentObservation } from "../src/sim/telemetry";
import { accountFor, forgetAccount, type Account } from "./auth";
import { env } from "./env";
import { createStore, competitorFor, humanCompetitor, storeIsShared, type Competitor, type CompetitorKind } from "./store";
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
const store = createStore();

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

/**
 * Burst limiter, per address.
 *
 * Not a quota -- the quota is the shared daily cap. This only stops one runaway
 * client spending the whole day's budget before anyone else gets a turn. Held
 * in memory on purpose: it protects against a loop, not against an adversary
 * with a botnet, and the daily cap is what protects against that.
 */
const burst = new Map<string, { count: number; second: number }>();
function withinBurst(address: string): boolean {
  const second = Math.floor(Date.now() / 1_000);
  const entry = burst.get(address);
  if (!entry || entry.second !== second) {
    // The map only ever holds addresses seen in the last second or two.
    if (burst.size > 10_000) burst.clear();
    burst.set(address, { count: 1, second });
    return true;
  }
  entry.count += 1;
  return entry.count <= env.publicBurstPerSecond;
}

app.use("/api/matches", async (context, next) =>
  context.req.method === "POST" ? requireToken(context, next) : next(),
);

app.get("/api/health", (context) => context.json({ ok: true, version: 2 }));

/** Which entrants this deployment can actually field. */
app.get("/api/agents", async (context) => {
  const available = [...providers()].map(([name, provider]) => {
    const info = provider.describe();
    const free = env.publicProviders.includes(name);
    return {
      kind: name,
      /** True when this deployment holds a credential for it. */
      available: provider.available(),
      /** True when anyone may use it without supplying a key. */
      free,
      /** True when it can be used by supplying your own key. */
      acceptsCallerKey: env.allowCallerKeys && name !== "scripted",
      ...info,
      pricing: priceOf(info.model) ?? null,
    };
  });
  const scripted = SCRIPTED_NAMES.map((name) => ({
    kind: name,
    available: true,
    free: true,
    acceptsCallerKey: false,
    name,
    provider: "scripted",
    model: name,
    policyVersion: "1",
    schema: "tactical" as const,
    pricing: null,
  }));
  const budget = await Promise.all(env.publicProviders.map(async (name) => {
    const used = await store.publicUsageToday(name);
    return {
      provider: name,
      decisions: used.decisions,
      costUsd: Number(used.costUsd.toFixed(6)),
      dailyBudgetUsd: env.publicDailyBudgetUsd,
      dailyDecisions: env.publicDailyDecisions,
      exhausted: used.costUsd >= env.publicDailyBudgetUsd || used.decisions >= env.publicDailyDecisions,
    };
  }));
  return context.json({ agents: [...scripted, ...available], freeBudget: budget });
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

  const kind = body.kind ?? env.publicProviders[0] ?? "jev";
  const liveMatchId = context.req.header("x-match-id")?.trim();

  /**
   * Whose credit is being spent decides who may ask.
   *
   * A caller who supplies their own key is paying for the call, so it is
   * allowed without a token and without touching the shared budget. A caller
   * who supplies nothing is spending this deployment's money, so the provider
   * has to be one offered for free and the day's cap has to have room left.
   */
  const callerKey = env.allowCallerKeys ? context.req.header("x-provider-key")?.trim() : undefined;
  const callerModel = context.req.header("x-provider-model")?.trim();
  const usingOwnKey = Boolean(callerKey);

  if (!usingOwnKey) {
    if (!env.publicProviders.includes(kind)) {
      return context.json(
        {
          error: `"${kind}" is not free on this deployment. Supply your own key, or use: ${env.publicProviders.join(", ") || "none"}.`,
          needsKey: true,
        },
        402,
      );
    }
    const address =
      context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      context.req.header("x-real-ip") ??
      "local";
    if (!withinBurst(address)) {
      return context.json({ error: "Too many requests; slow down." }, 429);
    }
    const used = await store.publicUsageToday(kind);
    if (used.costUsd >= env.publicDailyBudgetUsd || used.decisions >= env.publicDailyDecisions) {
      return context.json(
        {
          error: `The free daily allowance for "${kind}" is spent. It resets at 00:00 UTC, or supply your own key.`,
          needsKey: true,
          exhausted: true,
        },
        429,
      );
    }
  }

  const provider = providers({
    ...(callerKey ? { apiKey: callerKey } : {}),
    ...(callerModel ? { model: callerModel } : {}),
  }).get(kind);
  if (!provider) return context.json({ error: `Unknown provider "${kind}"` }, 400);
  if (!provider.available()) {
    return context.json({ error: `Provider "${kind}" has no credential`, needsKey: true }, 503);
  }

  try {
    const decision = validateDecision(await provider.decide(observation));
    if (!usingOwnKey) await store.recordPublicUsage(kind, decision.usage?.costUsd ?? 0);
    // Count it against the match ticket, so a result reported later can be
    // checked against what the server actually flew.
    if (liveMatchId) await store.noteLiveDecision(liveMatchId, decision.usage?.costUsd ?? 0);
    return context.json(decision);
  } catch (error) {
    // A provider error must not echo back anything that could contain the
    // caller's own key.
    const message = error instanceof Error ? error.message : String(error);
    return context.json({ error: callerKey ? message.split(callerKey).join("[key]") : message }, 502);
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

app.get("/api/matches", async (context) =>
  context.json({ matches: await store.listMatches({ limit: boundedLimit(context.req.query("limit")) }) }),
);

/** The signed-in player's own matches: the replay history browser's source. */
app.get("/api/me/matches", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  if (!account) return context.json({ error: "sign in to see your replays" }, 401);
  return context.json({
    matches: await store.listMatches({ limit: boundedLimit(context.req.query("limit")), userId: account.id }),
  });
});

app.get("/api/matches/:id", async (context) => {
  const match = await store.getMatch(context.req.param("id"));
  return match ? context.json(match) : context.json({ error: "not found" }, 404);
});

app.get("/api/matches/:id/replay", async (context) => {
  const replay = await store.getReplay(context.req.param("id"));
  if (!replay) return context.json({ error: "no replay stored for this match" }, 404);
  return new Response(replay, { headers: { "content-type": "application/json" } });
});

/**
 * The leaderboard, models by default.
 *
 * Humans are ranked on the same Elo scale and against the same models, but
 * they are a different question -- "which model flies best" is what the
 * benchmark is for -- so they are asked for explicitly rather than mixed in.
 */
app.get("/api/leaderboard", async (context) => {
  const requested = (context.req.query("kinds") ?? "model,scripted")
    .split(",")
    .map((kind) => kind.trim())
    .filter((kind): kind is CompetitorKind => kind === "model" || kind === "human" || kind === "scripted");
  return context.json({
    leaderboard: await store.leaderboard(requested.length ? requested : ["model", "scripted"]),
    kinds: requested,
  });
});

/** Who the caller is, if anyone. Lets the page render before it knows. */
app.get("/api/me", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  return context.json({ account: account ?? null, sharedLeaderboard: storeIsShared() });
});

app.post("/api/signout", (context) => {
  forgetAccount(context.req.header("authorization"));
  return context.json({ ok: true });
});

/**
 * Opens a live match and hands back a ticket.
 *
 * The ticket is what makes a browser-reported result worth recording. Every
 * decision for the match is counted against it, so a client cannot claim to
 * have beaten a model it never called. It does not stop somebody flying a real
 * match and lying about who won -- nothing short of a deterministic replay
 * would, and a live match is not deterministic by construction -- which is why
 * the replay is kept and the result is labelled with how far it was checked.
 */
app.post("/api/live/start", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  const body = (await context.req.json().catch(() => ({}))) as { opponent?: string };
  const opponent = typeof body.opponent === "string" ? body.opponent.slice(0, 64) : "basic";
  const id = randomUUID();
  await store.openLiveMatch({ id, userId: account?.id, opponentKind: opponent });
  // Ranked means "this server will record the result", which needs an account
  // and nothing else. Whether the results are shared with the world or sit in a
  // local file is a deployment question, reported separately.
  return context.json({ matchId: id, ranked: Boolean(account), shared: storeIsShared() });
});

/**
 * Reports the result of a live match.
 *
 * Checked against the ticket rather than believed: the match must exist, must
 * not already have been reported, and the server must have served a plausible
 * number of decisions for the opponent that is being claimed.
 */
app.post("/api/live/:id/result", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  if (!account) return context.json({ error: "sign in to have a result count" }, 401);

  const ticket = await store.settleLiveMatch(context.req.param("id"));
  if (!ticket) return context.json({ error: "no open match with that id" }, 409);
  if (ticket.userId && ticket.userId !== account.id) {
    return context.json({ error: "that match belongs to somebody else" }, 403);
  }

  const body = (await context.req.json()) as {
    summary?: MatchSummary;
    replay?: string;
    humanAircraftId?: string;
    opponentInfo?: { name: string; provider: string; model: string; policyVersion: string };
  };
  const summary = body.summary;
  const humanAircraftId = body.humanAircraftId;
  if (!summary || !Array.isArray(summary.aircraft) || summary.aircraft.length !== 2 || !humanAircraftId) {
    return context.json({ error: "a complete summary and the human's aircraft id are required" }, 400);
  }

  const opponentAircraft = summary.aircraft.find((aircraft) => aircraft.id !== humanAircraftId);
  if (!opponentAircraft) return context.json({ error: "the summary names only one aircraft" }, 400);

  const scripted = ticket.opponentKind === "basic" || ticket.opponentKind === "basic-pursuit";
  if (!scripted && ticket.decisionsServed < env.liveMatchMinimumDecisions) {
    return context.json(
      {
        error: `this server only flew ${ticket.decisionsServed} decisions for that match, so the result cannot be credited`,
        counted: false,
      },
      409,
    );
  }

  /**
   * A scripted opponent leaves no trace on the server, so the only thing left
   * to check is the clock: a match cannot be reported sooner than it could
   * possibly have been flown, even at the fastest time scale the page offers.
   * It is a weak check and it is the honest one available.
   */
  if (scripted) {
    const elapsedS = (Date.now() - Date.parse(ticket.createdAt)) / 1_000;
    const fastestPossibleS = (summary.durationS / MAX_TIME_SCALE) * 0.5;
    if (Number.isFinite(elapsedS) && elapsedS < fastestPossibleS) {
      return context.json(
        {
          error: `that match is reported as ${summary.durationS.toFixed(0)}s of flying but was started ${elapsedS.toFixed(0)}s ago`,
          counted: false,
        },
        409,
      );
    }
  }

  const opponentInfo = body.opponentInfo;
  const opponent: Competitor = scripted
    ? {
        id: `scripted:${ticket.opponentKind}:1`,
        kind: "scripted",
        displayName: ticket.opponentKind,
        provider: "scripted",
        model: ticket.opponentKind,
        policyVersion: "1",
      }
    : competitorFor({
        // Identity comes from the server's own view of the provider, never from
        // the client: otherwise anyone could report a win against any name.
        name: opponentInfo?.name ?? ticket.opponentKind,
        provider: ticket.opponentKind,
        model: providers().get(ticket.opponentKind)?.describe().model ?? ticket.opponentKind,
        policyVersion: providers().get(ticket.opponentKind)?.describe().policyVersion ?? "1",
        schema: "tactical",
      });

  const human = humanCompetitor(account.id, account.displayName, account.anonymous);

  try {
    await store.recordMatch({
      id: ticket.id,
      summary,
      competitors: { [humanAircraftId]: human, [opponentAircraft.id]: opponent },
      origin: "live",
      // The server served the decisions, so the match happened; it cannot
      // confirm the outcome, and does not claim to.
      verified: !scripted && ticket.decisionsServed >= env.liveMatchMinimumDecisions,
      replayJson: typeof body.replay === "string" ? body.replay : undefined,
      submittedBy: account.id,
    });
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }

  return context.json({ counted: true, matchId: ticket.id, provisional: human.provisional === true });
});

/** The fastest the live page will run a match, used to sanity-check the clock. */
const MAX_TIME_SCALE = 16;

/** Caps a caller-supplied page size, so one request cannot ask for everything. */
function boundedLimit(raw: string | undefined): number {
  const value = Number(raw ?? 50);
  return Number.isFinite(value) ? Math.max(1, Math.min(200, Math.floor(value))) : 50;
}

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
