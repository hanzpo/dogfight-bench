import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { contextFromState, resolveTactical } from "../src/agents/autopilot";
import { OnlineClient } from "../src/net/client";
import type { ClientMessage, Seat, ServerMessage } from "../src/net/protocol";
import { MatchRoom, type Connection } from "../src/net/room";
import { Random } from "../src/sim/random";
import type { ControlInput, MatchState } from "../src/sim/types";

const FRAME_MS = 1000 / 60;

/** A network in memory: each link has its own delay and jitter, and like a WebSocket never reorders. */
class Network {
  // A real wall clock's reading, not zero: the room is handed Date.now() in production.
  now = Date.UTC(2026, 8, 24);
  private queue: Array<{ at: number; order: number; deliver: () => void }> = [];
  private order = 0;
  private readonly random = new Random(11);
  private readonly linkClear = new Map<string, number>();

  later(link: string, delayMs: number, jitterMs: number, deliver: () => void): void {
    const at = Math.max(this.now + delayMs + this.random.next() * jitterMs, this.linkClear.get(link) ?? 0);
    this.linkClear.set(link, at);
    this.queue.push({ at, order: this.order++, deliver });
  }

  flush(): void {
    this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
    while (this.queue.length && this.queue[0]!.at <= this.now) this.queue.shift()!.deliver();
  }
}

/** Through JSON, as it would go over the wire. */
const wire = <T>(message: T): T => JSON.parse(JSON.stringify(message)) as T;

/** Bytes of every state message sent, to keep an eye on what a player downloads. */
const stateBytes: number[] = [];

function player(room: MatchRoom, net: Network, name: string, oneWayMs: number, jitterMs: number): OnlineClient {
  let client: OnlineClient;
  const connection: Connection = {
    send: (message: ServerMessage) => {
      if (message.type === "state") stateBytes.push(JSON.stringify(message).length);
      net.later(`${name}-down`, oneWayMs, jitterMs, () => client.receive(wire(message), net.now));
    },
    close: () => {},
  };
  client = new OnlineClient((message: ClientMessage) =>
    net.later(`${name}-up`, oneWayMs, jitterMs, () => room.receive(connection, wire(message))),
  );
  room.join(connection, name, "f16c");
  return client;
}

function run(net: Network, room: MatchRoom, ms: number, each: () => void): void {
  const end = net.now + ms;
  while (net.now < end) {
    net.now += FRAME_MS;
    net.flush();
    room.advance(net.now);
    each();
  }
}

function toFlying(net: Network, room: MatchRoom, a: OnlineClient, b: OnlineClient): void {
  const idle = () => {
    a.frame(net.now, LEVEL);
    b.frame(net.now, LEVEL);
  };
  run(net, room, 300, idle);
  a.choose({ type: "ready", ready: true });
  b.choose({ type: "ready", ready: true });
  run(net, room, 3_600, idle);
  expect(room.currentPhase).toBe("flying");
}

const LEVEL: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false };

function own(state: MatchState | undefined, seat: Seat) {
  return state?.aircraft.find((aircraft) => aircraft.id === seat);
}

describe("an online match", () => {
  it("fills two seats, counts down when both are ready, and starts the same fight for both", () => {
    const net = new Network();
    const room = new MatchRoom("TEST1");
    const a = player(room, net, "Alpha", 30, 5);
    const b = player(room, net, "Bravo", 60, 5);
    run(net, room, 200, () => {});
    expect(a.lobby?.players.map((p) => p.name)).toEqual(["Alpha", "Bravo"]);
    expect([a.seat, b.seat]).toEqual(["blue-1", "red-1"]);
    toFlying(net, room, a, b);
    run(net, room, 200, () => {
      a.frame(net.now, LEVEL);
      b.frame(net.now, LEVEL);
    });
    expect(a.scenario?.seed).toBe(b.scenario?.seed);
    // What the players are told, not just what the room knows: the page follows the lobby's phase.
    expect(a.lobby?.phase).toBe("flying");
    expect(b.lobby?.phase).toBe("flying");
    expect(a.state?.tick).toBeGreaterThan(0);
  });

  it("turns away a third player", () => {
    const net = new Network();
    const room = new MatchRoom("TEST2");
    player(room, net, "Alpha", 10, 0);
    player(room, net, "Bravo", 10, 0);
    const messages: ServerMessage[] = [];
    let closed = false;
    const seat = room.join({ send: (message) => messages.push(message), close: () => (closed = true) }, "Charlie", "f16c");
    expect(seat).toBeUndefined();
    expect(closed).toBe(true);
    expect(messages[0]).toMatchObject({ type: "error" });
  });

  it("keeps each player's own jet where the room has it, and the other close behind", () => {
    const net = new Network();
    const room = new MatchRoom("TEST3");
    const a = player(room, net, "Alpha", 40, 10);
    const b = player(room, net, "Bravo", 90, 10);
    toFlying(net, room, a, b);

    const truth = new Map<number, Vector3>();
    // What each client showed for Alpha at each tick, the moment it got there.
    const shownByAlpha = new Map<number, Vector3>();
    const shownByBravo = new Map<number, Vector3>();
    // Alpha changes what it is doing every second and a half; Bravo flies level.
    const start = net.now;
    const alpha = (): ControlInput => {
      const phase = Math.floor((net.now - start) / 1500) % 4;
      return { ...LEVEL, pitch: [0.3, -0.1, 0.5, 0][phase]!, roll: [0.4, -0.4, 0, 0.2][phase]! };
    };
    run(net, room, 8_000, () => {
      a.frame(net.now, alpha());
      b.frame(net.now, LEVEL);
      const sim = room.simulation!;
      truth.set(sim.state.tick, sim.state.aircraft[0]!.position.clone());
      if (net.now - start < 1_000) return;
      if (!shownByAlpha.has(a.state!.tick)) shownByAlpha.set(a.state!.tick, own(a.state, "blue-1")!.position.clone());
      if (!shownByBravo.has(b.state!.tick)) shownByBravo.set(b.state!.tick, own(b.state, "blue-1")!.position.clone());
    });
    const errors = (shown: Map<number, Vector3>) =>
      [...shown].flatMap(([tick, position]) => (truth.has(tick) ? [position.distanceTo(truth.get(tick)!)] : []));
    const ownErrors = errors(shownByAlpha);
    const remoteErrors = errors(shownByBravo);

    // Its own jet: exactly where the room will have it, because its inputs got there in time.
    // (Both sides step two ticks or so a frame, so only some of the ticks each records coincide.)
    expect(ownErrors.length).toBeGreaterThan(20);
    expect(remoteErrors.length).toBeGreaterThan(20);
    expect(Math.max(...ownErrors)).toBeLessThan(0.05);
    expect(room.lateInputs("blue-1")).toBeLessThan(10);
    expect(room.lateInputs("red-1")).toBeLessThan(10);
    // The other jet: guessed from its last known controls, so off by a little just after each change.
    const mean = remoteErrors.reduce((sum, error) => sum + error, 0) / remoteErrors.length;
    expect(mean).toBeLessThan(3);
    expect(Math.max(...remoteErrors)).toBeLessThan(25);
  });

  it("settles a fight flown over the network the same way for both players", () => {
    stateBytes.length = 0;
    const net = new Network();
    // Nose to nose at two kilometres, so the guns come into it at once.
    const room = new MatchRoom("TEST4", { seed: () => 0.25, scenario: { startSeparationM: 2_000 } });
    const a = player(room, net, "Alpha", 45, 15);
    const b = player(room, net, "Bravo", 70, 15);
    toFlying(net, room, a, b);

    // Alpha hunts from what it sees; Bravo flies on, straight and level.
    const hunter = (): ControlInput => {
      const me = own(a.state, "blue-1")!;
      const them = own(a.state, "red-1")!;
      const controls = resolveTactical(
        { schema: "tactical", maneuver: "lead_pursuit", targetG: 7, throttle: "ab", fire: false },
        contextFromState(me, them, a.scenario!.hardDeckAglM),
      );
      const to = them.position.clone().sub(me.position);
      const nose = new Vector3(0, 0, 1).applyQuaternion(me.orientation);
      const onTarget = to.length() < 900 && nose.angleTo(to) < 0.05;
      return { ...controls, fire: onTarget };
    };
    const cruising: ControlInput = { ...LEVEL, throttle: 0.6 };
    run(net, room, 30_000, () => {
      if (room.currentPhase !== "flying") return;
      a.frame(net.now, hunter());
      b.frame(net.now, cruising);
    });
    // A little longer, for the last word to reach both.
    run(net, room, 500, () => {});

    const final = room.simulation!.state;
    // Twenty a second, each a few kilobytes even with the guns going: well within a phone's connection.
    expect(stateBytes.reduce((sum, bytes) => sum + bytes, 0) / stateBytes.length).toBeLessThan(4_500);
    expect(final.finished).toBe(true);
    expect(final.winnerId).toBe("blue-1");
    for (const client of [a, b]) {
      expect(client.finished).toBe(true);
      expect(client.latest?.winnerId).toBe(final.winnerId);
      expect(client.events.filter((event) => event.type === "kill")).toEqual(
        final.events.filter((event) => event.type === "kill"),
      );
      expect(client.lobby?.phase).toBe("finished");
      expect(client.lobby?.last?.winner).toBe("blue-1");
    }
  });

  it("gives the fight to whoever stays when the other leaves", () => {
    const net = new Network();
    const room = new MatchRoom("TEST5");
    const connections: Connection[] = [];
    const a = new OnlineClient(() => {});
    const b = new OnlineClient(() => {});
    for (const [client, name] of [[a, "Alpha"], [b, "Bravo"]] as const) {
      const connection: Connection = { send: (message) => client.receive(wire(message), net.now), close: () => {} };
      connections.push(connection);
      room.join(connection, name, "f16c");
      room.receive(connection, { type: "ready", ready: true });
    }
    run(net, room, 3_500, () => {});
    expect(room.currentPhase).toBe("flying");
    room.leave(connections[1]!);
    expect(room.simulation?.state.winnerId).toBe("blue-1");
    expect(room.simulation?.state.finishReason).toBe("opponent left");
    expect(a.finished).toBe(true);
    expect(room.currentPhase).toBe("finished");
  });

  it("gives a returning tab its seat back, and mid-fight the whole fight again", () => {
    const net = new Network();
    const room = new MatchRoom("TEST6");
    const received: ServerMessage[][] = [[], [], []];
    const connect = (index: number, session: string) => {
      const connection: Connection = { send: (message) => received[index]!.push(wire(message)), close: () => {} };
      room.join(connection, `Pilot ${index}`, "f16c", session);
      return connection;
    };
    const first = connect(0, "tab-a");
    const other = connect(1, "tab-b");
    room.receive(first, { type: "ready", ready: true });
    room.receive(other, { type: "ready", ready: true });
    run(net, room, 3_500, () => {
      // Both keep talking, so neither is taken for gone.
      room.receive(first, { type: "ping", id: 1 });
      room.receive(other, { type: "ping", id: 1 });
    });
    expect(room.currentPhase).toBe("flying");

    // The same tab again, as after a dropped connection: the same seat, and the fight from the start of what it needs.
    const again = connect(2, "tab-a");
    run(net, room, 100, () => {
      room.receive(again, { type: "ping", id: 1 });
      room.receive(other, { type: "ping", id: 1 });
    });
    const back = received[2]!;
    expect(back.find((message) => message.type === "start")).toMatchObject({ you: "blue-1" });
    const state = back.find((message) => message.type === "state");
    expect(state).toBeDefined();
    expect(state!.type === "state" && state!.events.length).toBe(room.simulation!.state.events.length);
    expect(room.currentPhase).toBe("flying");
  });

  it("lets go of a player it has not heard from", () => {
    const net = new Network();
    const room = new MatchRoom("TEST7");
    let closed = false;
    const quiet: Connection = { send: () => {}, close: () => (closed = true) };
    room.join(quiet, "Quiet", "f16c");
    run(net, room, 16_000, () => {});
    expect(closed).toBe(true);
    expect(room.empty).toBe(true);
  });
});

