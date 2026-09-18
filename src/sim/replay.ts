import type { AgentAction } from "../agents/action";
import type { AgentAdapter, AgentDecision, AgentInfo } from "../agents/agent";
import type { AgentObservation } from "./telemetry";
import type { DecisionRecord, MatchSummary } from "./simulation";
import type { MatchState, ScenarioConfig, SimEvent } from "./types";
import { TRACER_TRAIL_SECONDS } from "./tracer";
import { degrees } from "../math";

export const REPLAY_FORMAT = "dogfight-replay";
export const REPLAY_VERSION = 3;

export interface ReplayAircraftFrame {
  id: string;
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  ammo: number;
  health: number;
  alive: boolean;
  s: [number, number, number, number, number, number, number];
}

export interface ReplayFrame {
  tick: number;
  t: number;
  aircraft: ReplayAircraftFrame[];
  projectiles?: Array<[number, number, number, number, number, number]>;
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: typeof REPLAY_VERSION;
  recordedAt: string;
  scenario: ScenarioConfig;
  agents: Record<string, AgentInfo>;
  frames: ReplayFrame[];
  events: SimEvent[];
  decisions: DecisionRecord[];
  summary?: MatchSummary;
}

export interface RecorderOptions {
  everyTicks?: number;
  includeProjectiles?: boolean;
}

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
    const interval = state.projectiles.length ? this.everyTicks : this.everyTicks * 2;
    if (state.tick % interval !== 0 && !state.finished) return;

    const frame: ReplayFrame = {
      tick: state.tick,
      t: Number(state.time.toFixed(4)),
      aircraft: state.aircraft.map((aircraft) => ({
        id: aircraft.id,
        p: round(aircraft.position.toArray() as [number, number, number], 1),
        q: round(aircraft.orientation.toArray() as [number, number, number, number], 5),
        v: round(aircraft.velocity.toArray() as [number, number, number], 1),
        ammo: aircraft.ammo,
        health: Number(aircraft.damage.integrity.toFixed(3)),
        alive: aircraft.alive,
        s: [
          Number(degrees(aircraft.aoaRad).toFixed(2)),
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
