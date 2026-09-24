import { Quaternion, Vector3 } from "three";
import { stepProjectiles } from "../sim/gun";
import { Random } from "../sim/random";
import { unpackRounds, type SimSnapshot } from "../sim/snapshot";
import { DogfightSimulation } from "../sim/simulation";
import type {
  AircraftState,
  ControlInput,
  MatchState,
  ProjectileState,
  ScenarioConfig,
  SimEvent,
} from "../sim/types";
import type { ClientMessage, Seat, ServerMessage } from "./protocol";

export type LobbyMessage = Extract<ServerMessage, { type: "lobby" }>;

/** How early inputs should reach the room, in ticks: a little slack against jitter. */
const TARGET_SLACK_TICKS = 3;
/** The furthest the prediction runs in one frame, so a stall catches up over a few frames rather than one. */
const MAX_STEPS_PER_FRAME = 30;
/** A correction smaller than this is eased in; a bigger one is a jump the eye should see. */
const SNAP_DISTANCE_M = 60;
/** How quickly a correction fades into the picture. */
const SMOOTHING_S = 0.12;
const PING_EVERY_MS = 1_000;
/** Rounds flown where nothing can be hit draw nothing from this. */
const NO_HITS = new Random(1);

interface Correction {
  position: Vector3;
  orientation: Quaternion;
}

/**
 * A player's side of an online match.
 *
 * It keeps its own copy of the simulation running a little ahead of the room,
 * far enough that its inputs arrive before the room needs them. The player's
 * own jet answers the stick at once; the opponent's flies on with the last
 * controls the room reported. Each snapshot from the room is the truth: the
 * copy is put back to it, and everything the player has done since is flown
 * again on top. What that moves is eased in rather than jumped to.
 *
 * Like the room, it knows nothing of sockets or frames: messages come in
 * through `receive`, time and the stick through `frame`.
 */
export class OnlineClient {
  lobby?: LobbyMessage;
  seat?: Seat;
  scenario?: ScenarioConfig;
  error?: string;
  /** Everything the room has said happened, in order. */
  readonly events: SimEvent[] = [];
  /** The newest snapshot, which is how the match really stands. */
  latest?: SimSnapshot;
  rttMs = 120;
  leadTicks = 12;

  private sim?: DogfightSimulation;
  private history: Array<{ tick: number; controls: ControlInput }> = [];
  private clockOffsetTicks?: number;
  private pings = new Map<number, number>();
  private pingId = 0;
  private lastPingAt = -Infinity;
  private corrections = new Map<string, Correction>();
  private lastFrameAt?: number;
  /** Every round the room has sent and not called back, flown on to `roundsTick`. */
  private rounds: ProjectileState[] = [];
  private roundsTick = 0;

  constructor(private readonly send: (message: ClientMessage) => void) {}

  get state(): MatchState | undefined {
    return this.sim?.state;
  }

  get finished(): boolean {
    return this.latest?.finished === true;
  }

  receive(message: ServerMessage, nowMs: number): void {
    switch (message.type) {
      case "lobby":
        this.lobby = message;
        this.seat = message.you;
        break;
      case "start":
        this.start(message.scenario, message.you);
        break;
      case "state":
        this.events.push(...message.events);
        this.latest = message.snapshot;
        this.syncClock(message.snapshot.tick, nowMs);
        if (message.ackTick >= 0) this.adjustLead(message.ackTick - message.snapshot.tick);
        this.reconcile(message.snapshot);
        break;
      case "pong": {
        const sentAt = this.pings.get(message.id);
        this.pings.delete(message.id);
        if (sentAt === undefined) break;
        this.rttMs = this.rttMs * 0.8 + (nowMs - sentAt) * 0.2;
        if (message.tick >= 0) this.syncClock(message.tick, nowMs);
        break;
      }
      case "error":
        this.error = message.message;
        break;
    }
  }

  private start(scenario: ScenarioConfig, seat: Seat): void {
    this.scenario = scenario;
    this.seat = seat;
    this.sim = new DogfightSimulation(scenario, { recordDecisions: false });
    this.events.length = 0;
    this.latest = undefined;
    this.history = [];
    this.clockOffsetTicks = undefined;
    this.corrections.clear();
    this.rounds = [];
    this.roundsTick = 0;
    // Start far enough ahead for the round trip measured in the lobby; the slack corrects it from there.
    this.leadTicks = Math.ceil(this.rttMs / 2 / this.stepMs) + TARGET_SLACK_TICKS + 2;
  }

  private get stepMs(): number {
    return (this.scenario?.fixedDt ?? 1 / 120) * 1000;
  }

  /** Where the room's clock is, estimated from a reading of it taken half a round trip ago. */
  private syncClock(serverTick: number, nowMs: number): void {
    const sample = serverTick + this.rttMs / 2 / this.stepMs - nowMs / this.stepMs;
    this.clockOffsetTicks = this.clockOffsetTicks === undefined ? sample : this.clockOffsetTicks * 0.9 + sample * 0.1;
  }

  /** Runs further ahead when inputs arrive late, and eases back when they arrive with time to spare. */
  private adjustLead(slack: number): void {
    const error = TARGET_SLACK_TICKS - slack;
    this.leadTicks = Math.max(2, Math.min(120, this.leadTicks + error * (error > 0 ? 0.3 : 0.05)));
  }

  serverTickAt(nowMs: number): number | undefined {
    return this.clockOffsetTicks === undefined ? undefined : nowMs / this.stepMs + this.clockOffsetTicks;
  }

  /**
   * Moves the prediction up to where it should be now, flying `controls`.
   * Call it every frame, in the lobby too: that is when the round trip gets measured.
   */
  frame(nowMs: number, controls: ControlInput): void {
    if (nowMs - this.lastPingAt >= PING_EVERY_MS) {
      this.lastPingAt = nowMs;
      this.pings.set(++this.pingId, nowMs);
      this.send({ type: "ping", id: this.pingId });
    }
    const wallDt = this.lastFrameAt === undefined ? 0 : (nowMs - this.lastFrameAt) / 1000;
    this.lastFrameAt = nowMs;
    this.decayCorrections(wallDt);

    const sim = this.sim;
    const serverTick = this.serverTickAt(nowMs);
    if (!sim || !this.seat || serverTick === undefined || sim.state.finished) return;

    const target = Math.floor(serverTick + this.leadTicks);
    if (sim.state.tick >= target) return;
    const first = sim.state.tick;
    this.remember(first, controls);
    this.send({ type: "input", tick: first, controls });
    for (let steps = 0; sim.state.tick < target && steps < MAX_STEPS_PER_FRAME && !sim.state.finished; steps += 1) {
      sim.setHumanControls(this.seat, controls);
      sim.step();
    }
  }

  private remember(tick: number, controls: ControlInput): void {
    while (this.history.length && this.history.at(-1)!.tick >= tick) this.history.pop();
    this.history.push({ tick, controls: { ...controls } });
  }

  private controlsAt(tick: number): ControlInput | undefined {
    let found: ControlInput | undefined;
    for (const entry of this.history) {
      if (entry.tick > tick) break;
      found = entry.controls;
    }
    return found;
  }

  /**
   * The rounds in the air at the snapshot's tick: the ones already known flown
   * on to it, less the ones the room says have stopped, plus the ones just fired.
   */
  private catchUpRounds(snapshot: SimSnapshot & { roundsGone: number[] }): ProjectileState[] {
    const sim = this.sim!;
    const aircraft = sim.state.aircraft;
    if (this.rounds.length) {
      // Flown against aeroplanes that cannot be hit: whether a round hit is the room's to say.
      const air = {
        ...sim.state,
        aircraft: aircraft.map((jet) => ({ ...jet, alive: false })),
        projectiles: this.rounds,
        events: [],
      };
      for (let tick = this.roundsTick; tick < snapshot.tick; tick += 1) {
        stepProjectiles(air, sim.config.fixedDt, NO_HITS);
      }
      this.rounds = air.projectiles;
    }
    const gone = new Set(snapshot.roundsGone);
    this.rounds = this.rounds.filter((round) => !gone.has(round.id)).concat(unpackRounds(snapshot.rounds, aircraft));
    this.roundsTick = snapshot.tick;
    return this.rounds;
  }

  /** Back to what the room says, then the player's own inputs since flown again on top. */
  private reconcile(snapshot: SimSnapshot & { roundsGone: number[] }): void {
    const sim = this.sim;
    if (!sim || !this.seat) return;
    const before = new Map(sim.state.aircraft.map((aircraft) => [aircraft.id, this.displayed(aircraft)]));
    const reached = sim.state.tick;

    sim.restore(snapshot, this.events, this.catchUpRounds(snapshot));
    while (sim.state.tick < reached && !sim.state.finished) {
      const controls = this.controlsAt(sim.state.tick);
      if (controls) sim.setHumanControls(this.seat, controls);
      sim.step();
    }

    // Keep the last input from before the snapshot: it is still what the stick was at.
    const keepFrom = this.history.findLastIndex((entry) => entry.tick <= snapshot.tick);
    if (keepFrom > 0) this.history.splice(0, keepFrom);

    for (const aircraft of sim.state.aircraft) {
      const shown = before.get(aircraft.id);
      if (!shown) continue;
      const position = shown.position.clone().sub(aircraft.position);
      if (position.length() > SNAP_DISTANCE_M) {
        this.corrections.delete(aircraft.id);
        continue;
      }
      const orientation = shown.orientation.clone().multiply(aircraft.orientation.clone().invert());
      this.corrections.set(aircraft.id, { position, orientation });
    }
  }

  private decayCorrections(dt: number): void {
    const keep = Math.exp(-dt / SMOOTHING_S);
    for (const correction of this.corrections.values()) {
      correction.position.multiplyScalar(keep);
      correction.orientation.slerp(new Quaternion(), 1 - keep);
    }
  }

  private displayed(aircraft: AircraftState): { position: Vector3; orientation: Quaternion } {
    const correction = this.corrections.get(aircraft.id);
    if (!correction) return { position: aircraft.position.clone(), orientation: aircraft.orientation.clone() };
    return {
      position: aircraft.position.clone().add(correction.position),
      orientation: correction.orientation.clone().multiply(aircraft.orientation),
    };
  }

  /** The predicted match as it should be drawn: with any correction still being eased in. */
  displayState(): MatchState | undefined {
    const state = this.sim?.state;
    if (!state) return undefined;
    if (!this.corrections.size) return state;
    return {
      ...state,
      aircraft: state.aircraft.map((aircraft) => {
        const shown = this.displayed(aircraft);
        return { ...aircraft, position: shown.position, orientation: shown.orientation };
      }),
    };
  }

  choose(message: Exclude<ClientMessage, { type: "input" | "ping" }>): void {
    this.send(message);
  }
}
