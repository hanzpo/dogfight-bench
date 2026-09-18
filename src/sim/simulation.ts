import type { AgentAdapter } from "../agents/agent";
import { validateDecision } from "../agents/agent";
import { stepAircraft } from "./flight-model";
import { fireGun, stepProjectiles } from "./gun";
import { Random } from "./random";
import { createNeutralMerge } from "./scenario";
import { observationFor } from "./telemetry";
import type { MatchState, ScenarioConfig } from "./types";

interface AgentSlot {
  agent: AgentAdapter;
  nextDecisionAt: number;
  sequence: number;
  pending: boolean;
  decisions: number;
  totalLatencyMs: number;
}

export class DogfightSimulation {
  readonly state: MatchState;
  private readonly rng: Random;
  private projectileId = 1;
  private readonly slots = new Map<string, AgentSlot>();

  constructor(readonly config: ScenarioConfig, readonly decisionIntervalS = 0.25) {
    this.state = createNeutralMerge(config);
    this.rng = new Random(config.seed);
  }

  attachAgent(aircraftId: string, agent: AgentAdapter): void {
    this.slots.set(aircraftId, { agent, nextDecisionAt: 0, sequence: 0, pending: false, decisions: 0, totalLatencyMs: 0 });
  }

  private requestDecisions(): Promise<void>[] {
    const requests: Promise<void>[] = [];
    for (const [aircraftId, slot] of this.slots) {
      if (slot.pending || this.state.time + 1e-9 < slot.nextDecisionAt || this.state.finished) continue;
      slot.pending = true;
      slot.nextDecisionAt += this.decisionIntervalS;
      const observation = observationFor(this.state, aircraftId, this.config, slot.sequence++);
      const started = performance.now();
      const request = slot.agent.decide(observation).then((decision) => {
        const aircraft = this.state.aircraft.find((a) => a.id === aircraftId);
        if (aircraft?.alive) aircraft.controls = validateDecision(decision).controls;
        slot.decisions += 1;
        slot.totalLatencyMs += performance.now() - started;
      }).catch(() => {
        // Hold the last valid controls on model/API failure.
      }).finally(() => { slot.pending = false; });
      requests.push(request);
    }
    return requests;
  }

  step(): MatchState {
    if (this.state.finished) return this.state;
    this.requestDecisions();
    return this.stepPhysics();
  }

  private stepPhysics(): MatchState {
    const dt = this.config.fixedDt;
    for (const aircraft of this.state.aircraft) {
      stepAircraft(aircraft, dt);
      fireGun(this.state, aircraft, dt, this.rng, () => this.projectileId++);
      if (aircraft.alive && aircraft.position.y <= 0) {
        aircraft.alive = false;
        this.state.events.push({ time: this.state.time, type: "ground-impact", actorId: aircraft.id });
      }
    }
    stepProjectiles(this.state, dt);
    this.state.time += dt;
    this.state.tick += 1;
    this.finishIfNeeded();
    return this.state;
  }

  /**
   * Runs without rendering or wall-clock pacing. At each decision boundary it
   * waits for both remote models, so network latency is measured but does not
   * grant either aircraft extra simulated time.
   */
  async runHeadless(): Promise<MatchState> {
    while (!this.state.finished) {
      const decisions = this.requestDecisions();
      if (decisions.length) await Promise.all(decisions);
      this.stepPhysics();
    }
    return this.state;
  }

  private finishIfNeeded(): void {
    const alive = this.state.aircraft.filter((a) => a.alive);
    if (alive.length <= 1) {
      this.state.finished = true;
      this.state.winnerId = alive[0]?.id;
      this.state.finishReason = alive.length === 1 ? "opponent destroyed" : "mutual destruction";
    } else if (this.state.time >= this.config.maxTime) {
      this.state.finished = true;
      this.state.finishReason = "time limit";
      this.state.events.push({ time: this.state.time, type: "timeout" });
    }
  }

  setHumanControls(aircraftId: string, controls: MatchState["aircraft"][number]["controls"]): void {
    const aircraft = this.state.aircraft.find((a) => a.id === aircraftId);
    if (aircraft) aircraft.controls = controls;
  }

  latencyStats(): Record<string, { decisions: number; averageMs: number }> {
    return Object.fromEntries([...this.slots].map(([id, s]) => [id, {
      decisions: s.decisions, averageMs: s.decisions ? s.totalLatencyMs / s.decisions : 0,
    }]));
  }
}
