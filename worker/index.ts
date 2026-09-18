import { app } from "../server/index";

/**
 * Running the benchmark on a Cloudflare Worker.
 *
 * The API is the same Hono app the Node entry mounts. Two things differ and
 * both are forced by the runtime rather than chosen:
 *
 * There is no filesystem, so the built viewer is served from Workers Assets
 * rather than from disk. Requests under `/api/` go to the app; everything else
 * goes to the asset store, which is configured to fall back to the application
 * shell so a reload on `/leaderboard` does not 404.
 *
 * There is no `node:sqlite` -- it imports and then refuses to construct -- so a
 * Worker must have a Supabase project configured. `server/store` picks Supabase
 * whenever its credentials are present, and the check below turns the absence
 * of them into a clear message rather than an "Illegal constructor" on the
 * first request that touches the database.
 */
export interface WorkerBindings {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return bindings.ASSETS.fetch(request);

    if (!process.env["SUPABASE_URL"] || !process.env["SUPABASE_SERVICE_ROLE_KEY"]) {
      return Response.json(
        {
          error:
            "This deployment has no results database. A Worker cannot use SQLite, so SUPABASE_URL and " +
            "SUPABASE_SERVICE_ROLE_KEY must be set.",
        },
        { status: 503 },
      );
    }

    return app.fetch(request, bindings, context);
  },
};
