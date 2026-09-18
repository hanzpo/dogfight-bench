import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, exposed, store } from "./index";
import { env } from "./env";
import { storeIsShared } from "./store";
import { providers } from "./providers";

/**
 * Running the benchmark as a Node process.
 *
 * This is the configuration for a laptop, a container or a virtual machine: it
 * serves the built viewer itself, so a deployment is one process rather than
 * two, and it can use a local SQLite file when no Supabase project is
 * configured. The Cloudflare Worker entry mounts the same app and can do
 * neither -- there is no filesystem to serve from and `node:sqlite` refuses to
 * construct -- which is why the two are separate files rather than one with a
 * runtime check in the middle.
 */

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
    console.log(`Results:   ${storeIsShared() ? "Supabase" : `SQLite at ${env.databasePath}`}`);

    /**
     * Say which cap is actually doing the work.
     *
     * Both a dollar limit and a decision limit guard the free tier, but a
     * provider that reports no price per call makes the dollar limit inert --
     * it can never be reached, so the decision count is the only thing standing
     * between an open deployment and its whole inference budget. Stating that
     * at startup is better than an operator inferring a limit that is not there.
     */
    const free = configured.filter((name) => env.publicProviders.includes(name));
    if (free.length) {
      console.log(
        `Free tier: ${free.join(", ")} -- ` +
          `$${env.publicDailyBudgetUsd}/day and ${env.publicDailyDecisions.toLocaleString()} decisions/day, shared by everyone`,
      );
      void Promise.all(free.map(async (name) => [name, await store.publicUsageToday(name)] as const)).then(
        (used) => {
          for (const [name, usage] of used) {
            if (usage.decisions > 0 && usage.costUsd === 0) {
              console.log(
                `           note: ${name} reports no price per call, so the dollar cap cannot bite; ` +
                  `the decision count is the effective limit`,
              );
            }
          }
        },
      );
    }

    if (exposed && !env.apiToken && configured.length) {
      console.warn(
        "WARNING: bound to a public interface with providers configured and no DOGFIGHT_API_TOKEN.\n" +
          "         A benchmark series (POST /api/matches) is disabled without it.",
      );
    }
  });
}

