import type { AgentAction } from "../agents/action";
import type { AgentAdapter, AgentDecision, AgentInfo } from "../agents/agent";
import type { AgentObservation } from "./telemetry";
import type { DecisionRecord, MatchSummary } from "./simulation";
import type { MatchState, ScenarioConfig, SimEvent } from "./types";

export const REPLAY_FORMAT = "dogfight-replay";
export const REPLAY_VERSION = 2;

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
}

export interface ReplayFrame {
  tick: number;
  t: number;
  aircraft: ReplayAircraftFrame[];
  /** Live projectile positions, so tracers can be drawn back exactly. */
  projectiles?: Array<[number, number, number]>;
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
  /** Capture one frame every N ticks. 4 at 120 Hz is 30 frames a second. */
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
    if (state.tick % this.everyTicks !== 0 && !state.finished) return;

    const frame: ReplayFrame = {
      tick: state.tick,
      t: Number(state.time.toFixed(4)),
      aircraft: state.aircraft.map((aircraft) => ({
        id: aircraft.id,
        p: round(aircraft.position.toArray() as [number, number, number], 2),
        q: round(aircraft.orientation.toArray() as [number, number, number, number], 5),
        v: round(aircraft.velocity.toArray() as [number, number, number], 2),
        ammo: aircraft.ammo,
        health: Number(aircraft.damage.integrity.toFixed(3)),
        alive: aircraft.alive,
      })),
    };
    if (this.includeProjectiles && state.projectiles.length) {
      frame.projectiles = state.projectiles.map(
        (shot) => round(shot.position.toArray() as [number, number, number], 1) as [number, number, number],
      );
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
