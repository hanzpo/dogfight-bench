import type { MatchState, ScenarioConfig } from "./types";

export interface ReplayFrame {
  tick: number;
  aircraft: Array<{ id: string; p: [number, number, number]; q: [number, number, number, number]; ammo: number; health: number }>;
}

export interface ReplayFile {
  format: "dogfight-replay";
  version: 1;
  scenario: ScenarioConfig;
  agents: Record<string, string>;
  frames: ReplayFrame[];
  result?: { winnerId?: string; reason?: string };
}

export class ReplayRecorder {
  readonly replay: ReplayFile;

  constructor(scenario: ScenarioConfig, agents: Record<string, string>, private everyTicks = 4) {
    this.replay = { format: "dogfight-replay", version: 1, scenario, agents, frames: [] };
  }

  capture(state: MatchState): void {
    if (state.tick % this.everyTicks !== 0 && !state.finished) return;
    this.replay.frames.push({
      tick: state.tick,
      aircraft: state.aircraft.map((a) => ({
        id: a.id, p: a.position.toArray(), q: a.orientation.toArray(), ammo: a.ammo, health: a.health,
      })),
    });
    if (state.finished) this.replay.result = { winnerId: state.winnerId, reason: state.finishReason };
  }

  toBlob(): Blob {
    return new Blob([JSON.stringify(this.replay)], { type: "application/json" });
  }
}
