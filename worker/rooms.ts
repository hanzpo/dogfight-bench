import { MatchRoom, type Connection } from "../src/net/room";
import { Matchmaker } from "../src/net/matchmaker";
import { isRoomCode } from "../src/net/protocol";
import { isAirframeId } from "../src/sim/airframes";

/** A countdown or a fight: a little faster than the fight's 120 Hz, so no tick waits long. */
const FAST_CLOCK_MS = 4;
/** In the lobby only the silence and the reconnection grace need the clock. */
const SLOW_CLOCK_MS = 250;

/**
 * One online match, as a Durable Object: every player in a room reaches this
 * same instance, which holds the room and runs its clock while anyone is in it.
 *
 * The clock is two intervals, a slow one always and a fast one while the room
 * is counting down or fighting. Intervals, and started only while handling a
 * request or a message: the Workers runtime will not run a timer set from
 * inside another timer's callback once the request behind it has finished.
 */
export class MatchRoomObject {
  private room?: MatchRoom;
  private slow?: ReturnType<typeof setInterval>;
  private fast?: ReturnType<typeof setInterval>;

  constructor(
    readonly state: DurableObjectState,
    readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Asked whether the code is free before it is handed out as a new room.
    if (url.searchParams.has("probe")) return Response.json({ free: !this.room || this.room.empty });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket.", { status: 426 });
    }
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
    const seat = room.join(connection, url.searchParams.get("name") ?? "", isAirframeId(airframe) ? airframe : "f16c", session);
    if (seat) {
      server.addEventListener("message", (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        room.receive(connection, message);
        this.pace();
      });
      // A dropped connection holds the seat for a while; the room lets it go if nobody comes back.
      const dropped = () => room.disconnect(connection);
      server.addEventListener("close", dropped);
      server.addEventListener("error", dropped);
      this.slow ??= setInterval(() => this.tick(), SLOW_CLOCK_MS);
      this.pace();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private tick(): void {
    try {
      this.room?.advance(Date.now());
    } catch (error) {
      console.error("room clock", error);
    }
    if (!this.room || this.room.empty) {
      this.stop();
    } else if (!this.room.busy && this.fast !== undefined) {
      clearInterval(this.fast);
      this.fast = undefined;
    }
  }

  /** The fast clock on when the room has just become busy. */
  private pace(): void {
    if (this.room?.busy) this.fast ??= setInterval(() => this.tick(), FAST_CLOCK_MS);
  }

  private stop(): void {
    clearInterval(this.slow);
    clearInterval(this.fast);
    this.slow = undefined;
    this.fast = undefined;
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
    if (url.pathname.endsWith("/status")) return Response.json({ waiting: this.matchmaker.someoneWaiting(Date.now()) });
    const session = url.searchParams.get("session")?.slice(0, 64) || crypto.randomUUID();
    const current = url.searchParams.get("code") ?? undefined;
    return Response.json(this.matchmaker.request(session, Date.now(), current && isRoomCode(current) ? current : undefined));
  }
}
