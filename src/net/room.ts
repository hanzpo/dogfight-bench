import type { AirframeId } from "../sim/airframes";
import { fox2Merge, neutralMerge } from "../sim/scenario";
import { sanitizeControls } from "../sim/flight-model";
import { DogfightSimulation } from "../sim/simulation";
import type { ControlInput, Loadout, ScenarioConfig } from "../sim/types";
import {
  COUNTDOWN_MS,
  SEATS,
  SNAPSHOT_EVERY_TICKS,
  cleanName,
  clientMessage,
  type LobbyPlayer,
  type Phase,
  type Seat,
  type ServerMessage,
} from "./protocol";

/** One player's line to the room: a WebSocket in production, a queue in a test. */
export interface Connection {
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

interface Player {
  seat: Seat;
  name: string;
  airframe: AirframeId;
  ready: boolean;
  /** Unset while they are away: the connection dropped, and the seat is held for them to come back. */
  connection?: Connection;
  /** When they went away, stamped at the next tick. */
  awaySinceMs?: number;
  /** Controls waiting for their tick, oldest first. */
  inputs: Array<{ tick: number; controls: ControlInput }>;
  /** What the jet is flying now. */
  controls: ControlInput;
  ackTick: number;
  sentEvents: number;
  /** Inputs that reached the room after their tick had been flown. */
  late: number;
  /** The browser tab behind the seat, so a new connection from it takes the seat back. */
  session?: string;
  /** When the room last heard from them; unset when just heard, and stamped at the next tick. */
  lastHeardMs?: number;
  /** A player who has come back mid-fight needs every round in the air, not just the new ones. */
  needsEverything: boolean;
}

export interface RoomOptions {
  /** A quick match starts on its own once both seats are taken. */
  quick?: boolean;
  seed?: () => number;
  /** Changes to the starting geometry, over the standard merge. */
  scenario?: Partial<Pick<ScenarioConfig, "startSeparationM" | "startAltitudeM" | "startSpeedMps" | "maxTime">>;
}

const NEUTRAL: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false, missile: false, flare: false };
/** How much input a player may queue ahead of the fight, in ticks: two seconds. */
const MAX_LEAD_TICKS = 240;
/** Past this the room stops trying to catch up with the clock, rather than freezing to do it. */
const MAX_CATCH_UP_MS = 250;
/**
 * Players ping every second, but a browser slows a hidden tab's timers to
 * one a minute; one silent longer than this is taken to have gone away,
 * however its connection looks.
 */
const SILENT_FOR_MS = 90_000;
/** How long a seat is held for a player whose connection dropped: long enough for a reload or a blip. */
const AWAY_GRACE_MS = 20_000;

/**
 * One online match: two seats, a lobby, and the fight itself.
 *
 * The room is the authority. It runs the same simulation the players' own
 * machines run, at the same fixed step, and what it says happened is what
 * happened; the players predict ahead of it so their own jets answer the
 * stick at once, and are corrected by what it sends them.
 *
 * Nothing here knows about Cloudflare: time comes in through `advance`, and
 * players are `Connection`s, so a test can run a whole match in memory.
 */
export class MatchRoom {
  private readonly players = new Map<Seat, Player>();
  private phase: Phase = "lobby";
  private weapons: Loadout = "guns";
  private host: Seat = "blue-1";
  private countdownEndsAt?: number;
  private sim?: DogfightSimulation;
  private lastAdvanceMs?: number;
  private accumulatorMs = 0;
  private last?: { winner?: Seat; reason?: string };
  /** The rounds every player has been sent and not yet told are gone. */
  private sentRounds = new Set<number>();

  constructor(
    readonly code: string,
    private readonly options: RoomOptions = {},
  ) {}

  get currentPhase(): Phase {
    return this.phase;
  }

  get empty(): boolean {
    return this.players.size === 0;
  }

  /** Whether the room needs its clock at full rate: counting down or fighting. */
  get busy(): boolean {
    return this.phase === "countdown" || this.phase === "flying";
  }

  /** How many of a player's inputs have arrived too late to fly at their own tick. */
  lateInputs(seat: Seat): number {
    return this.players.get(seat)?.late ?? 0;
  }

  /** The simulation while a match is on, for tests to look at. */
  get simulation(): DogfightSimulation | undefined {
    return this.sim;
  }

  join(connection: Connection, name: string, airframe: AirframeId, session?: string): Seat | undefined {
    const returning = session ? [...this.players.values()].find((player) => player.session === session) : undefined;
    if (returning) return this.rejoin(returning, connection);
    const seat = SEATS.find((candidate) => !this.players.has(candidate));
    if (!seat || this.phase === "flying" || this.phase === "countdown") {
      connection.send({ type: "error", message: seat ? "That match has already started." : "That room is full." });
      connection.close(4000, "room unavailable");
      return undefined;
    }
    if (!this.players.has(this.host)) this.host = seat;
    this.players.set(seat, {
      seat,
      name: cleanName(name, seat === "blue-1" ? "Blue" : "Red"),
      airframe,
      ready: false,
      connection,
      inputs: [],
      controls: NEUTRAL,
      ackTick: -1,
      sentEvents: 0,
      late: 0,
      ...(session ? { session } : {}),
      needsEverything: false,
    });
    this.maybeQuickStart();
    this.broadcastLobby();
    return seat;
  }

  /**
   * The same tab on a new connection -- a reload, a dropped network, a
   * second mount -- takes its seat back, and mid-fight picks the fight up.
   */
  private rejoin(player: Player, connection: Connection): Seat {
    player.connection?.close(4001, "replaced by a newer connection");
    player.connection = connection;
    player.lastHeardMs = undefined;
    player.awaySinceMs = undefined;
    if (this.phase === "flying" && this.sim) {
      player.sentEvents = 0;
      player.needsEverything = true;
      connection.send({ type: "start", scenario: this.sim.config, you: player.seat });
    }
    this.broadcastLobby();
    return player.seat;
  }

  /**
   * A connection dropped. The seat is held a while for the same tab to come
   * back -- a reload, a network blip -- with the jet flying on meanwhile.
   */
  disconnect(connection: Connection): void {
    const player = this.playerOn(connection);
    if (!player) return;
    player.connection = undefined;
    player.awaySinceMs = undefined;
    if (this.phase === "countdown") this.cancelCountdown();
    this.broadcastLobby();
  }

  /** A player gave up their seat: in a fight, that is conceding it. */
  leave(connection: Connection): void {
    const player = this.playerOn(connection);
    if (player) this.remove(player);
  }

  private playerOn(connection: Connection): Player | undefined {
    return [...this.players.values()].find((candidate) => candidate.connection === connection);
  }

  private remove(player: Player): void {
    this.players.delete(player.seat);
    if (this.phase === "flying" && this.sim && !this.sim.state.finished) {
      // Leaving mid-fight is conceding it.
      const state = this.sim.state;
      state.finished = true;
      state.winnerId = SEATS.find((seat) => seat !== player.seat);
      state.finishReason = "opponent left";
      this.finish();
    }
    if (this.phase === "countdown") this.cancelCountdown();
    for (const other of this.players.values()) other.ready = false;
    if (player.seat === this.host) this.host = this.players.keys().next().value ?? "blue-1";
    this.broadcastLobby();
  }

  receive(connection: Connection, raw: unknown): void {
    const player = this.playerOn(connection);
    if (!player) return;
    const parsed = clientMessage.safeParse(raw);
    if (!parsed.success) {
      connection.send({ type: "error", message: "That message was not understood." });
      return;
    }
    const message = parsed.data;
    player.lastHeardMs = undefined;
    const between = this.phase === "lobby" || this.phase === "finished";
    switch (message.type) {
      case "hello":
        player.name = cleanName(message.name, player.name);
        // A name can change any time; the jet only between fights, as with `choose`.
        if (between) player.airframe = message.airframe;
        this.broadcastLobby();
        break;
      case "leave":
        this.remove(player);
        connection.close(1000, "left");
        break;
      case "choose":
        if (!between) return;
        player.airframe = message.airframe;
        this.broadcastLobby();
        break;
      case "weapons":
        if (!between || player.seat !== this.host) return;
        this.weapons = message.weapons;
        for (const other of this.players.values()) other.ready = false;
        this.broadcastLobby();
        break;
      case "ready":
        if (!between) return;
        player.ready = message.ready;
        if (this.players.size === 2 && [...this.players.values()].every((candidate) => candidate.ready)) {
          this.startCountdown();
        }
        this.broadcastLobby();
        break;
      case "input": {
        if (this.phase !== "flying" || !this.sim) return;
        const now = this.sim.state.tick;
        if (message.tick > now + MAX_LEAD_TICKS) return;
        // Late input flies from now: the room never rewinds for one player.
        if (message.tick < now) player.late += 1;
        const tick = Math.max(message.tick, now);
        const last = player.inputs.at(-1);
        if (last && tick < last.tick) return;
        if (last && tick === last.tick) player.inputs.pop();
        player.inputs.push({ tick, controls: sanitizeControls(message.controls) });
        if (player.inputs.length > MAX_LEAD_TICKS) player.inputs.shift();
        player.ackTick = Math.max(player.ackTick, message.tick);
        break;
      }
      case "ping":
        connection.send({ type: "pong", id: message.id, tick: this.tickNow() });
        break;
    }
  }

  /** Moves the room on to `nowMs`: the countdown, and every tick of the fight that is due. */
  advance(nowMs: number): void {
    for (const player of [...this.players.values()]) {
      if (player.connection) {
        player.lastHeardMs ??= nowMs;
        if (nowMs - player.lastHeardMs > SILENT_FOR_MS) {
          const silent = player.connection;
          this.disconnect(silent);
          silent.close(4002, "no word for too long");
        }
      } else {
        player.awaySinceMs ??= nowMs;
        if (nowMs - player.awaySinceMs > AWAY_GRACE_MS) this.remove(player);
      }
    }
    if (this.phase === "countdown") {
      // The countdown is timed from the first moment the room sees after it was asked for.
      if (this.countdownEndsAt === undefined) {
        this.countdownEndsAt = nowMs + COUNTDOWN_MS;
        this.broadcastLobby(nowMs);
      } else if (nowMs >= this.countdownEndsAt) {
        this.startMatch(nowMs);
      }
      return;
    }
    if (this.phase !== "flying" || !this.sim) return;
    const elapsed = Math.min(nowMs - (this.lastAdvanceMs ?? nowMs), MAX_CATCH_UP_MS);
    this.lastAdvanceMs = nowMs;
    this.accumulatorMs += Math.max(0, elapsed);
    const stepMs = this.sim.config.fixedDt * 1000;
    while (this.accumulatorMs >= stepMs) {
      this.accumulatorMs -= stepMs;
      this.stepTick();
      if (this.sim.state.finished) {
        this.finish();
        return;
      }
      if (this.sim.state.tick % SNAPSHOT_EVERY_TICKS === 0) this.broadcastState();
    }
  }

  /** The fight's clock, including the part of a tick already under way. */
  private tickNow(): number {
    if (!this.sim || this.phase !== "flying") return -1;
    return this.sim.state.tick + this.accumulatorMs / (this.sim.config.fixedDt * 1000);
  }

  private maybeQuickStart(): void {
    if (this.options.quick && this.players.size === 2 && this.phase === "lobby") this.startCountdown();
  }

  private startCountdown(): void {
    this.phase = "countdown";
    this.countdownEndsAt = undefined;
  }

  private cancelCountdown(): void {
    this.phase = "lobby";
    this.countdownEndsAt = undefined;
    for (const player of this.players.values()) player.ready = false;
  }

  private startMatch(nowMs: number): void {
    const base = this.weapons === "fox2" ? fox2Merge : neutralMerge;
    const seed = Math.floor((this.options.seed ?? Math.random)() * 2 ** 31);
    const airframes = Object.fromEntries(SEATS.map((seat) => [seat, this.players.get(seat)?.airframe ?? "f16c"]));
    const scenario = { ...base, ...this.options.scenario, id: `${base.id}-online`, seed, airframes };
    this.sim = new DogfightSimulation(scenario, { recordDecisions: false });
    this.phase = "flying";
    this.countdownEndsAt = undefined;
    this.lastAdvanceMs = nowMs;
    this.accumulatorMs = 0;
    this.sentRounds = new Set();
    for (const player of this.players.values()) {
      player.inputs = [];
      player.controls = NEUTRAL;
      player.ackTick = -1;
      player.sentEvents = 0;
      player.late = 0;
      player.ready = false;
      player.connection?.send({ type: "start", scenario, you: player.seat });
    }
    this.broadcastLobby();
    this.broadcastState();
  }

  private stepTick(): void {
    const sim = this.sim!;
    const tick = sim.state.tick;
    for (const player of this.players.values()) {
      while (player.inputs.length && player.inputs[0]!.tick <= tick) player.controls = player.inputs.shift()!.controls;
      sim.setHumanControls(player.seat, player.controls);
    }
    sim.step();
  }

  private finish(): void {
    const state = this.sim!.state;
    this.broadcastState();
    this.phase = "finished";
    this.last = { winner: SEATS.find((seat) => seat === state.winnerId), reason: state.finishReason };
    for (const player of this.players.values()) player.ready = false;
    this.broadcastLobby();
  }

  private broadcastState(): void {
    const sim = this.sim;
    if (!sim) return;
    const rounds = sim.state.projectiles;
    const live = new Set(rounds.map((round) => round.id));
    const fresh = rounds.filter((round) => !this.sentRounds.has(round.id));
    const roundsGone = [...this.sentRounds].filter((id) => !live.has(id));
    this.sentRounds = live;
    const snapshot = { ...sim.snapshot(fresh), roundsGone };
    for (const player of this.players.values()) {
      const events = sim.state.events.slice(player.sentEvents);
      player.sentEvents = sim.state.events.length;
      const everything = player.needsEverything ? { ...sim.snapshot(), roundsGone: [] } : snapshot;
      player.needsEverything = false;
      player.connection?.send({ type: "state", snapshot: everything, events, ackTick: player.ackTick });
    }
  }

  private broadcastLobby(nowMs?: number): void {
    const players: LobbyPlayer[] = SEATS.flatMap((seat) => {
      const player = this.players.get(seat);
      return player
        ? [{ seat, name: player.name, airframe: player.airframe, ready: player.ready, connected: player.connection !== undefined }]
        : [];
    });
    for (const player of this.players.values()) {
      player.connection?.send({
        type: "lobby",
        code: this.code,
        you: player.seat,
        host: this.host,
        phase: this.phase,
        players,
        weapons: this.weapons,
        ...(this.phase === "countdown" && this.countdownEndsAt !== undefined && nowMs !== undefined
          ? { countdownMs: Math.max(0, this.countdownEndsAt - nowMs) }
          : {}),
        ...(this.last ? { last: this.last } : {}),
      });
    }
  }
}
