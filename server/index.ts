import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { validateDecision } from "../src/agents/agent";
import type { MatchSummary } from "../src/sim/simulation";
import type { AgentObservation } from "../src/sim/telemetry";
import { accountFor, forgetAccount, type Account } from "./auth";
import { env, redactSecrets } from "./env";
import { createStore, competitorFor, humanCompetitor, storeIsShared, type Competitor, type CompetitorKind } from "./store";
import { runSeries, type SeriesRequest } from "./match-runner";
import { SCRIPTED_NAMES, providers } from "./providers";
import { priceOf } from "./pricing";
import { clamp } from "../src/math";

const app = new Hono();
const store = createStore();

export const exposed =
  (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") ||
  (env.host !== "127.0.0.1" && env.host !== "localhost");

if (env.allowedOrigins.length) {
  app.use("/api/*", cors({ origin: env.allowedOrigins }));
}

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
 * A body that is not JSON is the caller's mistake, not this server's.
 *
 * `context.req.json()` throws on a malformed body, and with nothing catching it
 * the request fell through to Hono's default handler: a 500 with a plain-text
 * body, from an API where every other error is JSON. A client reading the
 * response as JSON got a parse error instead of the reason.
 */
class BadRequest extends Error {}

async function readJson<T>(context: Context): Promise<T> {
  try {
    return (await context.req.json()) as T;
  } catch {
    throw new BadRequest("the request body is not valid JSON");
  }
}

/** Nothing leaves as an unhandled throw, and nothing leaves carrying a secret. */
app.onError((error, context) => {
  if (error instanceof BadRequest) return context.json({ error: error.message }, 400);
  const message = error instanceof Error ? error.message : String(error);
  console.error("unhandled", message);
  return context.json({ error: redactSecrets(message) }, 500);
});

const burst = new Map<string, { count: number; second: number }>();
function withinBurst(address: string): boolean {
  const second = Math.floor(Date.now() / 1_000);
  const entry = burst.get(address);
  if (!entry || entry.second !== second) {
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

app.get("/api/agents", async (context) => {
  const available = [...providers()].map(([name, provider]) => {
    const info = provider.describe();
    const free = env.publicProviders.includes(name);
    return {
      kind: name,
      available: provider.available(),
      free,
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

app.post("/api/decide", async (context) => {
  const body = await readJson<{
    agentId?: string;
    kind?: string;
    observation?: AgentObservation;
  }>(context);
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
    if (liveMatchId) await store.noteLiveDecision(liveMatchId, decision.usage?.costUsd ?? 0);
    return context.json(decision);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return context.json({ error: redactSecrets(message, callerKey) }, 502);
  }
});

app.post("/api/matches", async (context) => {
  if (!env.allowSeries) {
    return context.json(
      { error: "This deployment does not run benchmark series; use `npm run bench` on a machine that can." },
      501,
    );
  }
  const request = await readJson<SeriesRequest>(context);
  if (!request?.blue?.kind || !request?.red?.kind) {
    return context.json({ error: "blue.kind and red.kind are required" }, 400);
  }
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
    return context.json({ error: redactSecrets(error instanceof Error ? error.message : String(error)) }, 500);
  } finally {
    running = false;
  }
});

let running = false;

app.get("/api/matches", async (context) =>
  context.json({ matches: await store.listMatches({ limit: boundedLimit(context.req.query("limit")) }) }),
);

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

app.get("/api/me", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  return context.json({ account: account ?? null, sharedLeaderboard: storeIsShared() });
});

app.post("/api/signout", (context) => {
  forgetAccount(context.req.header("authorization"));
  return context.json({ ok: true });
});

app.post("/api/live/start", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  const body = (await context.req.json().catch(() => ({}))) as { opponent?: string };
  const opponent = typeof body.opponent === "string" ? body.opponent.slice(0, 64) : "basic";
  const id = randomUUID();
  await store.openLiveMatch({ id, userId: account?.id, opponentKind: opponent });
  return context.json({ matchId: id, ranked: Boolean(account), shared: storeIsShared() });
});

app.post("/api/live/:id/result", async (context) => {
  const account = await accountFor(context.req.header("authorization"));
  if (!account) return context.json({ error: "sign in to have a result count" }, 401);

  const ticket = await store.settleLiveMatch(context.req.param("id"));
  if (!ticket) return context.json({ error: "no open match with that id" }, 409);
  if (ticket.userId && ticket.userId !== account.id) {
    return context.json({ error: "that match belongs to somebody else" }, 403);
  }

  const body = await readJson<{
    summary?: MatchSummary;
    replay?: string;
    humanAircraftId?: string;
    opponentInfo?: { name: string; provider: string; model: string; policyVersion: string };
  }>(context);
  const summary = body.summary;
  const humanAircraftId = body.humanAircraftId;
  if (!summary || !Array.isArray(summary.aircraft) || summary.aircraft.length !== 2 || !humanAircraftId) {
    return context.json({ error: "a complete summary and the human's aircraft id are required" }, 400);
  }

  const opponentAircraft = summary.aircraft.find((aircraft) => aircraft.id !== humanAircraftId);
  if (!opponentAircraft) return context.json({ error: "the summary names only one aircraft" }, 400);

  const canonicalScripted: Record<string, string> = {
    basic: "energy-fighter",
    "energy-fighter": "energy-fighter",
    "basic-pursuit": "basic-pursuit",
  };
  const scriptedName = canonicalScripted[ticket.opponentKind];
  const scripted = scriptedName !== undefined;
  if (!scripted && ticket.decisionsServed < env.liveMatchMinimumDecisions) {
    return context.json(
      {
        error: `this server only flew ${ticket.decisionsServed} decisions for that match, so the result cannot be credited`,
        counted: false,
      },
      409,
    );
  }

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

  const opponent = opponentCompetitor(scriptedName, ticket.opponentKind, body.opponentInfo);

  const human = humanCompetitor(account.id, account.displayName, account.anonymous);

  try {
    await store.recordMatch({
      id: ticket.id,
      summary,
      competitors: { [humanAircraftId]: human, [opponentAircraft.id]: opponent },
      origin: "live",
      verified: !scripted && ticket.decisionsServed >= env.liveMatchMinimumDecisions,
      replayJson: typeof body.replay === "string" ? body.replay : undefined,
      submittedBy: account.id,
    });
  } catch (error) {
    return context.json({ error: redactSecrets(error instanceof Error ? error.message : String(error)) }, 500);
  }

  return context.json({ counted: true, matchId: ticket.id, provisional: human.provisional === true });
});

function opponentCompetitor(
  scriptedName: string | undefined,
  kind: string,
  reported: { name: string; provider: string; model: string; policyVersion: string } | undefined,
): Competitor {
  if (scriptedName !== undefined) {
    return {
      id: `scripted:${scriptedName}:1`,
      kind: "scripted",
      displayName: scriptedName,
      provider: "scripted",
      model: scriptedName,
      policyVersion: "1",
      schema: "tactical",
    };
  }
  // The server's own description of the model, not the browser's: the client
  // reports which opponent it flew, never what that opponent's rating belongs to.
  const described = providers().get(kind)?.describe();
  return competitorFor({
    name: reported?.name ?? kind,
    provider: kind,
    model: described?.model ?? kind,
    policyVersion: described?.policyVersion ?? "1",
    // The interface is part of the identity, so a model flying the stick must
    // not be credited to the same entrant as the one naming manoeuvres.
    schema: described?.schema ?? "tactical",
  });
}

const MAX_TIME_SCALE = 16;

function boundedLimit(raw: string | undefined): number {
  const value = Number(raw ?? 50);
  return Number.isFinite(value) ? clamp(Math.floor(value), 1, 200) : 50;
}

export { app, store };
