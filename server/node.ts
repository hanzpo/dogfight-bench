import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, exposed, store } from "./index";
import { env } from "./env";
import { storeIsShared } from "./store";
import { providers } from "./providers";

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

