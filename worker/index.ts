import { app } from "../server/index";

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
