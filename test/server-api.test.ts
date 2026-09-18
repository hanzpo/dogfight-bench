import { beforeAll, describe, expect, it } from "vitest";
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
  process.env["NODE_ENV"] = "test";
  ({ app } = await import("../server/index"));
});

function sampleObservation() {
  const sim = new DogfightSimulation(neutralMerge);
  for (let i = 0; i < 120; i += 1) sim.step();
  return observationFor(sim.state, "blue-1", neutralMerge, 0);
}

const post = (path: string, body: unknown, token?: string) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
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

  it("refuses to spend provider credits without the token", async () => {
    expect((await post("/api/decide", { observation: sampleObservation() })).status).toBe(401);
    expect((await post("/api/decide", { observation: sampleObservation() }, "wrong")).status).toBe(401);
  });

  it("refuses to run a benchmark series without the token", async () => {
    const body = { blue: { kind: "energy-fighter" }, red: { kind: "basic-pursuit" }, rounds: 1 };
    expect((await post("/api/matches", body)).status).toBe(401);
  });

  it("rejects a malformed observation as a bad request, not a provider failure", async () => {
    const response = await post("/api/decide", { observation: {} }, "test-token");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/observation/i);
  });

  it("caps how much paid work one request can queue", async () => {
    const body = { blue: { kind: "energy-fighter" }, red: { kind: "basic-pursuit" }, rounds: 9_999 };
    const response = await post("/api/matches", body, "test-token");
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/rounds/i);
  });

  it("does not leak a provider credential through any endpoint", async () => {
    for (const path of ["/api/agents", "/api/leaderboard", "/api/health"]) {
      const text = await (await app.fetch(new Request(`http://localhost${path}`))).text();
      expect(text).not.toContain("not-a-real-key");
      expect(text).not.toContain("test-token");
    }
  });
});
