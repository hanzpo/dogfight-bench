import type { AgentAction } from "../agents/action";
import type { AgentAdapter, AgentDecision, AgentInfo } from "../agents/agent";
import type { AgentObservation } from "./telemetry";
import type { DecisionRecord, MatchSummary } from "./simulation";
import type { MatchState, ScenarioConfig, SimEvent } from "./types";
import { TRACER_TRAIL_SECONDS } from "./tracer";

export const REPLAY_FORMAT = "dogfight-replay";
export const REPLAY_VERSION = 3;

export interface ReplayAircraftFrame {
  id: string;
  /** Position [east, up, south]. */
  p: [number, number, number];
  /** Orientation quaternion [x, y, z, w]. */
  q: [number, number, number, number];
  /** Velocity, m/s. */
  v: [number, number, number];
  ammo: number;
  health: number;
  alive: boolean;
  /**
   * Enough instrument state to drive the same display live flight uses.
   *
   * Without it a replay can only be watched from outside, with no airspeed, no
   * attitude, no g and no fuel -- which is most of what makes a recording worth
   * reviewing. Ordered tuple rather than named fields to keep the file small:
   * angle of attack (deg), load factor, fuel (kg), throttle, and flags for
   * afterburner, alpha limiting and departure.
   */
  s: [number, number, number, number, number, number, number];
}

export interface ReplayFrame {
  tick: number;
  t: number;
  aircraft: ReplayAircraftFrame[];
  /**
   * Tracers as finished line segments: tail then head.
   *
   * Storing positions alone meant the viewer had no idea which way a round was
   * travelling, and fell back to drawing a short vertical stroke -- so every
   * replayed burst looked like a picket fence. Recording both ends removes the
   * guess, and makes replay and live rendering identical by construction.
   */
  projectiles?: Array<[number, number, number, number, number, number]>;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: typeof REPLAY_VERSION;
  recordedAt: string;
  scenario: ScenarioConfig;
  /** Agent metadata per aircraft, so a result is attributable to a model. */
  agents: Record<string, AgentInfo>;
  frames: ReplayFrame[];
  events: SimEvent[];
  /**
   * Every decision, in order. This is the deterministic action log: replaying
   * it reproduces a headless match exactly, without needing the models again.
   * See `ReplayAgent`. Matches recorded in real time replay approximately,
   * because a model's answer lands whenever the network returns it.
   */
  decisions: DecisionRecord[];
  summary?: MatchSummary;
}

export interface RecorderOptions {
  /**
   * Capture one frame every N ticks while rounds are in the air, and half as
   * often otherwise. 4 at 120 Hz is 30 frames a second.
   */
  everyTicks?: number;
  includeProjectiles?: boolean;
}

/**
 * Records a match.
 *
 * The frame stream is for playback; the decision log is for reproduction. They
 * are kept separate because a replay that can only be watched cannot be used to
 * audit a result, and a log that cannot be watched is no use to a viewer.
 */
export class ReplayRecorder {
  readonly replay: ReplayFile;
  private readonly everyTicks: number;
  private readonly includeProjectiles: boolean;
  private capturedEvents = 0;

  constructor(scenario: ScenarioConfig, agents: Record<string, AgentInfo>, options: RecorderOptions = {}) {
    this.everyTicks = Math.max(1, options.everyTicks ?? 4);
    this.includeProjectiles = options.includeProjectiles ?? true;
    this.replay = {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      recordedAt: new Date().toISOString(),
      scenario,
      agents,
      frames: [],
      events: [],
      decisions: [],
    };
  }

  capture(state: MatchState): void {
    if (state.events.length > this.capturedEvents) {
      this.replay.events.push(...state.events.slice(this.capturedEvents));
      this.capturedEvents = state.events.length;
    }
    /**
     * Aircraft frames are most of a replay's size, and playback interpolates
     * between them, so half the rate costs almost nothing to watch. Tracers do
     * not interpolate: each frame draws a short streak along the round's path,
     * and at fifteen frames a second a burst arrives as dots with gaps between
     * them. So the rate halves only while there is nothing in the air.
     */
    const interval = state.projectiles.length ? this.everyTicks : this.everyTicks * 2;
    if (state.tick % interval !== 0 && !state.finished) return;

    const frame: ReplayFrame = {
      tick: state.tick,
      t: Number(state.time.toFixed(4)),
      aircraft: state.aircraft.map((aircraft) => ({
        id: aircraft.id,
        // A tenth of a metre, on an aircraft fifteen metres long.
        p: round(aircraft.position.toArray() as [number, number, number], 1),
        q: round(aircraft.orientation.toArray() as [number, number, number, number], 5),
        v: round(aircraft.velocity.toArray() as [number, number, number], 1),
        ammo: aircraft.ammo,
        health: Number(aircraft.damage.integrity.toFixed(3)),
        alive: aircraft.alive,
        s: [
          Number(((aircraft.aoaRad * 180) / Math.PI).toFixed(2)),
          Number(aircraft.loadFactor.toFixed(2)),
          Number(aircraft.engine.fuelKg.toFixed(1)),
          Number(aircraft.controls.throttle.toFixed(3)),
          aircraft.engine.afterburner ? 1 : 0,
          aircraft.flcs.limiterActive ? 1 : 0,
          aircraft.flcs.departed ? 1 : 0,
        ],
      })),
    };
    if (this.includeProjectiles && state.projectiles.length) {
      frame.projectiles = state.projectiles.map((shot) => {
        const speed = shot.velocity.length();
        const trail = Math.min(TRACER_TRAIL_SECONDS * speed, speed * shot.age);
        const direction = shot.velocity.clone().divideScalar(Math.max(speed, 1e-6));
        const tail = shot.position.clone().addScaledVector(direction, -trail);
        return [
          ...(round(tail.toArray() as [number, number, number], 1) as [number, number, number]),
          ...(round(shot.position.toArray() as [number, number, number], 1) as [number, number, number]),
        ] as [number, number, number, number, number, number];
      });
    }
    this.replay.frames.push(frame);
  }

  /** Attaches the decision log and result once the match is over. */
  finish(decisions: DecisionRecord[], summary: MatchSummary): void {
    this.replay.decisions = decisions;
    this.replay.summary = summary;
  }

  toJSON(): string {
    return JSON.stringify(this.replay);
  }

  toBlob(): Blob {
    return new Blob([this.toJSON()], { type: "application/json" });
  }
}

function round<T extends number[]>(values: T, digits: number): T {
  const factor = 10 ** digits;
  return values.map((value) => Math.round(value * factor) / factor) as T;
}

/**
 * Replays a recorded decision log.
 *
 * Attaching these instead of the original agents reproduces a match exactly
 * when the original was recorded through `runHeadless`,
 * which is what makes a published result auditable: anyone can re-run it
 * without API keys, without paying for inference, and without the model being
 * available any more.
 */
export class ReplayAgent implements AgentAdapter {
  readonly info: AgentInfo;
  private index = 0;
  private readonly actions: AgentAction[];

  constructor(
    public readonly id: string,
    replay: ReplayFile,
    aircraftId: string,
  ) {
    this.info = replay.agents[aircraftId] ?? {
      name: "replay",
      provider: "replay",
      model: "replay",
      policyVersion: "1",
      schema: "tactical",
    };
    this.actions = replay.decisions
      .filter((decision) => decision.aircraftId === aircraftId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((decision) => decision.action);
  }

  reset(): void {
    this.index = 0;
  }

  async decide(_observation: AgentObservation): Promise<AgentDecision> {
    const action = this.actions[this.index] ?? this.actions[this.actions.length - 1];
    this.index += 1;
    return {
      action: action ?? { schema: "tactical", maneuver: "level", targetG: 1, throttle: "mil", fire: false },
      rationale: "replayed",
    };
  }
}

export function parseReplay(text: string): ReplayFile {
  const replay = JSON.parse(text) as ReplayFile;
  if (replay.format !== REPLAY_FORMAT) throw new Error("Not a dogfight replay");
  if (replay.version !== REPLAY_VERSION) {
    throw new Error(`Unsupported replay version ${replay.version}; expected ${REPLAY_VERSION}`);
  }
  return replay;
}
