import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { observationFor } from "../src/sim/telemetry";

/**
 * The paid endpoints are the ones that can cost real money if left open, so
 * their guard is tested rather than trusted.
 */
let app: { fetch: (request: Request) => Response | Promise<Response> };

beforeAll(async () => {
  process.env["DOGFIGHT_DB"] = ":memory:";
  process.env["DOGFIGHT_API_TOKEN"] = "test-token";
  process.env["ANTHROPIC_API_KEY"] = "not-a-real-key";
  process.env["SUPABASE_URL"] = "https://project.test";
  process.env["SUPABASE_ANON_KEY"] = "anon-key";
  process.env["NODE_ENV"] = "test";
  ({ app } = await import("../server/index"));
});

/**
 * Stands in for Supabase's token endpoint.
 *
 * The server verifies an access token by asking Supabase who it belongs to, so
 * a test of the account-gated endpoints has to answer that question. Only the
 * auth call is intercepted; anything else the server reaches for is a mistake
 * this should make obvious rather than quietly satisfy.
 */
function withSignedInUser(id: string, metadata: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      return new Response(JSON.stringify({ id, is_anonymous: true, user_metadata: metadata }), { status: 200 });
    }
    throw new Error(`unexpected outbound request to ${url}`);
  });
  // A distinct token per user: the server caches verified tokens, so reusing
  // one across tests would hand back the previous test's account.
  return { authorization: `Bearer ${id.replace(/-/g, "")}${"t".repeat(8)}` };
}

afterEach(() => vi.unstubAllGlobals());

const SAMPLE_RESULT = {
  humanAircraftId: "blue-1",
  summary: {
    scenarioId: "neutral-merge",
    seed: 1,
    // Short, so the clock check below is satisfied by a brief wait rather than
    // by sleeping for the length of a real match.
    durationS: 12,
    winnerId: "blue-1",
    reason: "opponent destroyed",
    aircraft: [
      { id: "blue-1", team: "blue", alive: true, health: 1, hitsTaken: 0, hitsScored: 3, roundsFired: 90, ammoRemaining: 400, fuelRemainingKg: 900, timeOnTargetS: 4, timeInControlZoneS: 9 },
      { id: "red-1", team: "red", alive: false, health: 0, hitsTaken: 3, hitsScored: 0, roundsFired: 10, ammoRemaining: 500, fuelRemainingKg: 900, timeOnTargetS: 0, timeInControlZoneS: 0 },
    ],
    agents: {},
  },
};

async function startMatch(opponent: string, headers: Record<string, string>): Promise<string> {
  const response = await post("/api/live/start", { opponent }, undefined, headers);
  return (await response.json()).matchId as string;
}

/** Long enough that a 12-second match could have been flown at 16x. */
const flyingTime = () => new Promise((resolve) => setTimeout(resolve, 500));

function sampleObservation() {
  const sim = new DogfightSimulation(neutralMerge);
  for (let i = 0; i < 120; i += 1) sim.step();
  return observationFor(sim.state, "blue-1", neutralMerge, 0);
}

const post = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

describe("the benchmark API", () => {
  it("serves read-only data without a token", async () => {
    const response = await app.fetch(new Request("http://localhost/api/leaderboard"));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("leaderboard");
  });

  /**
   * Who pays decides who may ask.
   *
   * Anyone may use a provider this deployment offers for free, up to a shared
   * daily cap. Everything else has to arrive with the caller's own key -- the
   * whole point being that an open deployment can offer one model without
   * offering its entire inference budget to the internet.
   */
  it("refuses to spend this deployment's credit on a provider that is not free", async () => {
    const response = await post("/api/decide", { kind: "anthropic", observation: sampleObservation() });
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.needsKey).toBe(true);
    expect(body.error).toMatch(/your own key/i);
  });

  it("lets a caller use a paid provider with their own key", async () => {
    // Reaching the provider at all is the assertion: the request gets past the
    // gate and fails at the network, rather than being refused as unpaid.
    const response = await app.fetch(
      new Request("http://localhost/api/decide", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-provider-key": "sk-caller-supplied",
          "x-provider-model": "gpt-4.1-mini",
        },
        body: JSON.stringify({ kind: "openai", observation: sampleObservation() }),
      }),
    );
    expect(response.status).not.toBe(402);
    expect(response.status).not.toBe(401);
  });

  it("never echoes a caller's key back in an error", async () => {
    const response = await app.fetch(
      new Request("http://localhost/api/decide", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-provider-key": "sk-caller-supplied",
          "x-provider-model": "gpt-4.1-mini",
        },
        body: JSON.stringify({ kind: "openai", observation: sampleObservation() }),
      }),
    );
    expect(await response.text()).not.toContain("sk-caller-supplied");
  });

  it("says which providers are free and what is left of the day's allowance", async () => {
    const body = await (await app.fetch(new Request("http://localhost/api/agents"))).json();
    const jev = body.agents.find((agent: { kind: string }) => agent.kind === "jev");
    expect(jev.free).toBe(true);
    const anthropic = body.agents.find((agent: { kind: string }) => agent.kind === "anthropic");
    expect(anthropic.free).toBe(false);
    expect(anthropic.acceptsCallerKey).toBe(true);
    expect(body.freeBudget[0]).toMatchObject({ provider: "jev", exhausted: false });
  });

  it("refuses to run a benchmark series without the token", async () => {
    const body = { blue: { kind: "energy-fighter" }, red: { kind: "basic-pursuit" }, rounds: 1 };
    expect((await post("/api/matches", body)).status).toBe(401);
  });

  it("rejects a malformed observation as a bad request, not a provider failure", async () => {
    const response = await post("/api/decide", { kind: "jev", observation: {} }, "test-token");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/observation/i);
  });

  it("caps how much paid work one request can queue", async () => {
    const body = { blue: { kind: "energy-fighter" }, red: { kind: "basic-pursuit" }, rounds: 9_999 };
    const response = await post("/api/matches", body, "test-token");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/rounds/i);
  });

  /**
   * A browser-reported result is a claim, not a fact.
   *
   * The server issues a ticket when a match starts and counts the decisions it
   * serves against it, so somebody cannot report a win over a model they never
   * called. It cannot tell whether a real match was reported honestly -- a live
   * match is not reproducible by construction -- so it records how far it
   * checked rather than pretending otherwise.
   */
  it("will not record a result for somebody who is not signed in", async () => {
    const response = await post("/api/live/some-id/result", SAMPLE_RESULT);
    expect(response.status).toBe(401);
  });

  it("refuses a claimed win over a model it never flew", async () => {
    const headers = withSignedInUser("11111111-1111-1111-1111-111111111111");
    const matchId = await startMatch("jev", headers);
    const response = await post(`/api/live/${matchId}/result`, SAMPLE_RESULT, undefined, headers);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.counted).toBe(false);
    expect(body.error).toMatch(/0 decisions/);
  });

  it("records a match against a scripted opponent and ranks the player", async () => {
    const headers = withSignedInUser("22222222-2222-2222-2222-222222222222", { name: "Ana" });
    const matchId = await startMatch("basic", headers);
    await flyingTime();

    const first = await post(`/api/live/${matchId}/result`, SAMPLE_RESULT, undefined, headers);
    expect(first.status).toBe(200);
    expect((await first.json()).counted).toBe(true);

    // Reporting the same match again must not be accepted, or a single win
    // could be banked repeatedly.
    const again = await post(`/api/live/${matchId}/result`, SAMPLE_RESULT, undefined, headers);
    expect(again.status).toBe(409);

    // A guest is rated -- the scripted opponent's rating moved -- but is not
    // listed, or one person with a fresh guest session each time is the board.
    const board = await (await app.fetch(new Request("http://localhost/api/leaderboard?kinds=human"))).json();
    expect(
      board.leaderboard.some(
        (row: { competitorId: string }) => row.competitorId === "human:22222222-2222-2222-2222-222222222222",
      ),
    ).toBe(false);

    const scripted = await (await app.fetch(new Request("http://localhost/api/leaderboard"))).json();
    const opponent = scripted.leaderboard.find(
      (row: { competitorId: string }) => row.competitorId === "scripted:energy-fighter:1",
    );
    expect(opponent.losses).toBe(1);
    expect(opponent.rating).toBeLessThan(1500);
  });

  /**
   * A scripted opponent leaves no trace on the server, so the only thing left
   * to check is the clock: a match cannot be reported sooner than it could
   * possibly have been flown, even at the fastest speed the page offers.
   */
  it("refuses a scripted match reported sooner than it could have been flown", async () => {
    const headers = withSignedInUser("44444444-4444-4444-4444-444444444444");
    const matchId = await startMatch("basic", headers);
    const response = await post(
      `/api/live/${matchId}/result`,
      { ...SAMPLE_RESULT, summary: { ...SAMPLE_RESULT.summary, durationS: 280 } },
      undefined,
      headers,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/started/);
  });

  /**
   * The viewer calls the energy fighter "basic". That is a label, not an
   * identity; recording it under that name gave the same opponent two
   * competitors and split its rating between them.
   */
  it("records a scripted opponent under one identity whatever the UI calls it", async () => {
    const headers = withSignedInUser("33333333-3333-3333-3333-333333333333");
    const matchId = await startMatch("basic", headers);
    await flyingTime();
    await post(`/api/live/${matchId}/result`, SAMPLE_RESULT, undefined, headers);

    const board = await (await app.fetch(new Request("http://localhost/api/leaderboard"))).json();
    const ids = board.leaderboard.map((row: { competitorId: string }) => row.competitorId);
    expect(ids).toContain("scripted:energy-fighter:1");
    expect(ids).not.toContain("scripted:basic:1");
  });

  it("keeps people off the default leaderboard", async () => {
    const board = await (await app.fetch(new Request("http://localhost/api/leaderboard"))).json();
    expect(board.leaderboard.every((row: { kind: string }) => row.kind !== "human")).toBe(true);
  });

  it("does not leak a provider credential through any endpoint", async () => {
    for (const path of ["/api/agents", "/api/leaderboard", "/api/health"]) {
      const text = await (await app.fetch(new Request(`http://localhost${path}`))).text();
      expect(text).not.toContain("not-a-real-key");
      expect(text).not.toContain("test-token");
    }
  });
});
