import { app } from "../server/index";
import { isRoomCode, newRoomCode } from "../src/net/protocol";

export { MatchRoomObject, MatchmakerObject } from "./rooms";

export interface WorkerBindings {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  ROOMS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/**
 * Online play: a new room, a quick match, and the WebSocket into a room.
 * It needs no results database, so it answers before anything that does.
 */
async function online(request: Request, url: URL, bindings: WorkerBindings): Promise<Response | undefined> {
  const path = url.pathname;
  if (path === "/api/online/rooms" && request.method === "POST") {
    // A handful of tries: with millions of codes, a live room is almost never drawn twice in a row.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newRoomCode();
      const probe = await bindings.ROOMS.get(bindings.ROOMS.idFromName(code)).fetch(`https://room/?probe=1`);
      if (((await probe.json()) as { free: boolean }).free) return Response.json({ code });
    }
    return Response.json({ error: "No free room just now; try again." }, { status: 503 });
  }
  if (path === "/api/online/quick" || path === "/api/online/quick/cancel" || path === "/api/online/quick/status") {
    const reading = path.endsWith("/status");
    if (request.method !== (reading ? "GET" : "POST")) return new Response(null, { status: 405 });
    const matchmaker = bindings.MATCHMAKER.get(bindings.MATCHMAKER.idFromName("quick"));
    return matchmaker.fetch(
      new Request(`https://matchmaker${path.slice("/api/online".length)}${url.search}`, { method: request.method }),
    );
  }
  const room = /^\/api\/online\/rooms\/([^/]+)\/socket$/.exec(path);
  if (room) {
    const code = room[1]!.toUpperCase();
    if (!isRoomCode(code)) return Response.json({ error: "That is not a room code." }, { status: 404 });
    const target = new URL(request.url);
    target.searchParams.set("code", code);
    return bindings.ROOMS.get(bindings.ROOMS.idFromName(code)).fetch(new Request(target, request));
  }
  return undefined;
}

export default {
  async fetch(request: Request, bindings: WorkerBindings, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) return bindings.ASSETS.fetch(request);

    if (url.pathname.startsWith("/api/online/")) {
      return (await online(request, url, bindings)) ?? Response.json({ error: "not found" }, { status: 404 });
    }

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
