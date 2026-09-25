import { MatchRoom, type Connection } from "../src/net/room";
import { Matchmaker } from "../src/net/matchmaker";
import { isAirframeId } from "../src/sim/airframes";

/**
 * How often the room's clock is checked: a little faster than its 120 Hz, so
 * no tick waits long. An interval, because the Workers runtime will not run a
 * timer that a timer's callback sets once the request behind it has finished.
 */
const CLOCK_MS = 4;

/**
 * One online match, as a Durable Object: every player in a room reaches this
 * same instance, which holds the room and runs its clock while anyone is in it.
 */
export class MatchRoomObject {
  private room?: MatchRoom;
  private clock?: ReturnType<typeof setInterval>;

  constructor(
    readonly state: DurableObjectState,
    readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket.", { status: 426 });
    }
    const url = new URL(request.url);
    const airframe = url.searchParams.get("airframe");
    this.room ??= new MatchRoom(url.searchParams.get("code") ?? "", { quick: url.searchParams.get("quick") === "1" });
    const room = this.room;

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const connection: Connection = {
      send: (message) => {
        try {
          server.send(JSON.stringify(message));
        } catch {
          // Already gone; the close handler tidies up.
        }
      },
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {
          // Already closed.
        }
      },
    };

    const session = url.searchParams.get("session")?.slice(0, 64) || undefined;
    const seat = room.join(
      connection,
      url.searchParams.get("name") ?? "",
      isAirframeId(airframe) ? airframe : "f16c",
      session,
    );
    if (seat) {
      server.addEventListener("message", (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        room.receive(connection, message);
      });
      const gone = () => {
        room.leave(connection);
        if (room.empty) this.stopClock();
      };
      server.addEventListener("close", gone);
      server.addEventListener("error", gone);
      this.startClock();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private startClock(): void {
    this.clock ??= setInterval(() => {
      try {
        this.room?.advance(Date.now());
      } catch (error) {
        console.error("room clock", error);
      }
    }, CLOCK_MS);
  }

  private stopClock(): void {
    if (this.clock !== undefined) clearInterval(this.clock);
    this.clock = undefined;
    this.room = undefined;
  }
}

/** The quick-match queue, as a Durable Object: one instance for everyone, so two players asking at once cannot both be told to wait. */
export class MatchmakerObject {
  private readonly matchmaker = new Matchmaker();

  constructor(
    readonly state: DurableObjectState,
    readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/cancel")) {
      const code = url.searchParams.get("code");
      if (code) this.matchmaker.cancel(code);
      return Response.json({ ok: true });
    }
    const session = url.searchParams.get("session")?.slice(0, 64) || crypto.randomUUID();
    return Response.json(this.matchmaker.request(session, Date.now()));
  }
}
