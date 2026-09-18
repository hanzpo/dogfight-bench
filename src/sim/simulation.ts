import type { AgentAdapter, AgentInfo, DecisionUsage } from "../agents/agent";
import { AgentTimeoutError, decideWithTimeout, resolveAction, validateDecision } from "../agents/agent";
import type { AgentAction } from "../agents/action";
import { isDestroyed } from "./damage";
import { stepAircraft } from "./flight-model";
import { fireGun, stepProjectiles } from "./gun";
import { Random } from "./random";
import { createNeutralMerge } from "./scenario";
import { terrainHeight } from "./terrain";
import { observationFor } from "./telemetry";
import type { AircraftState, MatchState, ScenarioConfig } from "./types";

/** Seconds outside the arena or below the floor before the match is forfeit. */
const BOUNDARY_GRACE_S = 5;
/** Fuel below which a bingo call is emitted once, kilograms. */
const BINGO_FUEL_KG = 450;

interface AgentSlot {
  agent: AgentAdapter;
  nextDecisionAt: number;
  sequence: number;
  pending: boolean;
  decisions: number;
  failures: number;
  timeouts: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastDecisionAt: number;
  lastEventIndex: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** One model decision, kept so a replay can reproduce and explain a match. */
export interface DecisionRecord {
  tick: number;
  time: number;
  aircraftId: string;
  sequence: number;
  action: AgentAction;
  rationale?: string;
  latencyMs: number;
  usage?: DecisionUsage;
  error?: string;
}

export interface SimulationOptions {
  /** Simulated seconds between decisions for every agent. */
  decisionIntervalS?: number;
  /**
   * Wall-clock deadline for a single decision. A model that misses it holds its
   * previous command, which is the same thing that happens to a pilot who
   * hesitates.
   */
  decisionTimeoutMs?: number;
  /** Match is abandoned if an agent spends more than this on inference. */
  inferenceBudgetUsd?: number;
  /** Set false to stop retaining every decision, for long headless sweeps. */
  recordDecisions?: boolean;
}

interface AircraftBookkeeping {
  outsideArenaFor: number;
  belowDeckFor: number;
  bingoCalled: boolean;
  wasDeparted: boolean;
}

export interface MatchSummary {
  scenarioId: string;
  seed: number;
  durationS: number;
  winnerId?: string;
  reason?: string;
  aircraft: Array<{
    id: string;
    team: string;
    alive: boolean;
    health: number;
    hitsTaken: number;
    hitsScored: number;
    roundsFired: number;
    ammoRemaining: number;
    fuelRemainingKg: number;
    /** Seconds spent with a valid gun solution on the opponent. */
    timeOnTargetS: number;
    /** Seconds spent inside the opponent's rear quarter inside 2 km. */
    timeInControlZoneS: number;
    destroyedBy?: string;
    destroyedReason?: string;
  }>;
  agents: Record<string, AgentStats>;
}

export interface AgentStats {
  info?: AgentInfo;
  decisions: number;
  failures: number;
  timeouts: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export class DogfightSimulation {
  readonly state: MatchState;
  private readonly rng: Random;
  private projectileId = 1;
  private readonly slots = new Map<string, AgentSlot>();
  private readonly bookkeeping = new Map<string, AircraftBookkeeping>();
  private readonly scoring = new Map<string, { roundsFired: number; hitsScored: number; timeOnTargetS: number; timeInControlZoneS: number }>();

  readonly decisionIntervalS: number;
  readonly decisionTimeoutMs: number;
  readonly inferenceBudgetUsd: number;
  readonly decisions: DecisionRecord[] = [];
  private readonly recordDecisions: boolean;

  constructor(
    readonly config: ScenarioConfig,
    options: SimulationOptions | number = {},
  ) {
    const settings = typeof options === "number" ? { decisionIntervalS: options } : options;
    this.decisionIntervalS = settings.decisionIntervalS ?? 0.25;
    this.decisionTimeoutMs = settings.decisionTimeoutMs ?? 0;
    this.inferenceBudgetUsd = settings.inferenceBudgetUsd ?? Infinity;
    this.recordDecisions = settings.recordDecisions ?? true;
    this.state = createNeutralMerge(config);
    this.rng = new Random(config.seed);
    for (const aircraft of this.state.aircraft) {
      this.bookkeeping.set(aircraft.id, {
        outsideArenaFor: 0,
        belowDeckFor: 0,
        bingoCalled: false,
        wasDeparted: false,
      });
      this.scoring.set(aircraft.id, { roundsFired: 0, hitsScored: 0, timeOnTargetS: 0, timeInControlZoneS: 0 });
    }
  }

  attachAgent(aircraftId: string, agent: AgentAdapter): void {
    agent.reset?.();
    this.slots.set(aircraftId, {
      agent,
      nextDecisionAt: 0,
      sequence: 0,
      pending: false,
      decisions: 0,
      failures: 0,
      timeouts: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      lastDecisionAt: 0,
      lastEventIndex: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  }

  private requestDecisions(): Promise<void>[] {
    const requests: Promise<void>[] = [];
    for (const [aircraftId, slot] of this.slots) {
      if (slot.pending || this.state.time + 1e-9 < slot.nextDecisionAt || this.state.finished) continue;
      const aircraft = this.state.aircraft.find((candidate) => candidate.id === aircraftId);
      if (!aircraft?.alive) continue;

      slot.pending = true;
      slot.nextDecisionAt += this.decisionIntervalS;
      const observation = observationFor(this.state, aircraftId, this.config, slot.sequence++, {
        secondsSinceLastDecisionS: this.state.time - slot.lastDecisionAt,
        sinceEventIndex: slot.lastEventIndex,
      });
      slot.lastDecisionAt = this.state.time;
      slot.lastEventIndex = this.state.events.length;

      const started = performance.now();
      const sequence = slot.sequence - 1;
      const request = decideWithTimeout(slot.agent, observation, this.decisionTimeoutMs)
        .then((raw) => {
          const decision = validateDecision(raw);
          const target = this.state.aircraft.find((candidate) => candidate.id === aircraftId);
          if (target?.alive) target.controls = resolveAction(decision.action, observation);
          slot.decisions += 1;
          slot.costUsd += decision.usage?.costUsd ?? 0;
          slot.inputTokens += decision.usage?.inputTokens ?? 0;
          slot.outputTokens += decision.usage?.outputTokens ?? 0;
          this.record({
            tick: this.state.tick,
            time: this.state.time,
            aircraftId,
            sequence,
            action: decision.action,
            rationale: decision.rationale,
            latencyMs: performance.now() - started,
            usage: decision.usage,
          });
        })
        .catch((error: unknown) => {
          // Hold the last valid command. A model that fails does not get to
          // freeze the match, but the failure is recorded against it.
          slot.failures += 1;
          if (error instanceof AgentTimeoutError) slot.timeouts += 1;
          this.record({
            tick: this.state.tick,
            time: this.state.time,
            aircraftId,
            sequence,
            action: { schema: "raw", controls: { ...this.state.aircraft.find((c) => c.id === aircraftId)!.controls } },
            latencyMs: performance.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          const latency = performance.now() - started;
          slot.totalLatencyMs += latency;
          slot.maxLatencyMs = Math.max(slot.maxLatencyMs, latency);
          slot.pending = false;
        });
      requests.push(request);
    }
    return requests;
  }

  private record(decision: DecisionRecord): void {
    if (this.recordDecisions) this.decisions.push(decision);
  }

  step(): MatchState {
    if (this.state.finished) return this.state;
    this.requestDecisions();
    return this.stepPhysics();
  }

  private stepPhysics(): MatchState {
    const dt = this.config.fixedDt;
    const eventCount = this.state.events.length;

    for (const aircraft of this.state.aircraft) {
      const ammoBefore = aircraft.ammo;
      stepAircraft(aircraft, dt);
      fireGun(this.state, aircraft, dt, this.rng, () => this.projectileId++);
      this.scoring.get(aircraft.id)!.roundsFired += ammoBefore - aircraft.ammo;
      this.trackAircraft(aircraft, dt);
    }

    stepProjectiles(this.state, dt, this.rng);
    for (const event of this.state.events.slice(eventCount)) {
      if (event.type === "hit" && event.actorId) this.scoring.get(event.actorId)!.hitsScored += 1;
    }
    this.trackPositionalScore(dt);

    this.state.time += dt;
    this.state.tick += 1;
    this.finishIfNeeded();
    return this.state;
  }

  /** Terrain, arena bounds, fuel and departure bookkeeping for one aircraft. */
  private trackAircraft(aircraft: AircraftState, dt: number): void {
    if (!aircraft.alive) return;
    const book = this.bookkeeping.get(aircraft.id)!;

    if (aircraft.flcs.departed !== book.wasDeparted) {
      this.state.events.push({
        time: this.state.time,
        type: aircraft.flcs.departed ? "departure" : "recovery",
        actorId: aircraft.id,
      });
      book.wasDeparted = aircraft.flcs.departed;
    }

    if (!book.bingoCalled && aircraft.engine.fuelKg < BINGO_FUEL_KG) {
      book.bingoCalled = true;
      this.state.events.push({ time: this.state.time, type: "bingo-fuel", actorId: aircraft.id });
    }

    if (aircraft.position.y <= terrainHeight(aircraft.position.x, aircraft.position.z)) {
      this.destroy(aircraft, "terrain impact");
      this.state.events.push({ time: this.state.time, type: "ground-impact", actorId: aircraft.id });
      return;
    }

    book.belowDeckFor = aircraft.heightAboveGroundM < this.config.hardDeckAglM ? book.belowDeckFor + dt : 0;
    if (book.belowDeckFor > BOUNDARY_GRACE_S) {
      this.destroy(aircraft, "hard deck violation");
      return;
    }

    const distance = Math.hypot(aircraft.position.x, aircraft.position.z);
    book.outsideArenaFor = distance > this.config.arenaRadiusM ? book.outsideArenaFor + dt : 0;
    if (book.outsideArenaFor > BOUNDARY_GRACE_S) {
      this.destroy(aircraft, "left the arena");
    }
  }

  private destroy(aircraft: AircraftState, reason: string): void {
    aircraft.alive = false;
    aircraft.destroyedReason = reason;
    aircraft.damage.integrity = 0;
    aircraft.health = 0;
  }

  /**
   * Positional scoring. Time spent with a gun solution, and time spent in the
   * opponent's rear quarter, decide a match that runs out of clock -- otherwise
   * two passive models would draw every time.
   */
  private trackPositionalScore(dt: number): void {
    const [first, second] = this.state.aircraft;
    if (!first || !second) return;
    for (const [own, opponent] of [
      [first, second],
      [second, first],
    ] as const) {
      if (!own.alive || !opponent.alive) continue;
      const relative = observationFor(this.state, own.id, this.config, 0).relative;
      const score = this.scoring.get(own.id)!;
      if (relative.gunSolution.trackingSolution) score.timeOnTargetS += dt;
      if (relative.rangeM < 2_000 && relative.angleOffTailDeg < 45) score.timeInControlZoneS += dt;
    }
  }

  /**
   * Runs without rendering or wall-clock pacing. At each decision boundary it
   * waits for both models, so inference latency is measured but neither
   * aircraft gets extra simulated time for being slow.
   *
   * This is also the reproducible mode. Because every decision is applied on
   * the tick it was requested, a recorded decision log replays exactly. Real
   * -time play cannot promise that: a model's answer lands whenever the network
   * returns it, so the same log would be applied on different ticks.
   */
  async runHeadless(onTick?: (state: MatchState) => void): Promise<MatchState> {
    while (!this.state.finished) {
      const decisions = this.requestDecisions();
      if (decisions.length) await Promise.all(decisions);
      this.stepPhysics();
      onTick?.(this.state);
    }
    return this.state;
  }

  private finishIfNeeded(): void {
    for (const aircraft of this.state.aircraft) {
      if (aircraft.alive && isDestroyed(aircraft.damage)) this.destroy(aircraft, "airframe destroyed");
    }

    const spent = this.overBudget();
    if (spent) {
      this.state.finished = true;
      this.state.winnerId = this.state.aircraft.find((aircraft) => aircraft.id !== spent)?.id;
      this.state.finishReason = `${spent} exceeded its inference budget`;
      return;
    }

    const alive = this.state.aircraft.filter((aircraft) => aircraft.alive);
    if (alive.length <= 1) {
      this.state.finished = true;
      this.state.winnerId = alive[0]?.id;
      this.state.finishReason = alive.length === 1 ? "opponent destroyed" : "mutual destruction";
      return;
    }

    if (this.state.time >= this.config.maxTime) {
      this.state.finished = true;
      this.state.events.push({ time: this.state.time, type: "timeout" });
      const decision = this.decideOnPoints();
      this.state.winnerId = decision.winnerId;
      this.state.finishReason = decision.reason;
    }
  }

  /** Breaks a timed-out match on damage dealt, then gun time, then energy. */
  private decideOnPoints(): { winnerId?: string; reason: string } {
    const ranked = [...this.state.aircraft].sort((a, b) => this.points(b) - this.points(a));
    const [leader, trailer] = ranked;
    if (!leader || !trailer) return { reason: "time limit" };
    if (Math.abs(this.points(leader) - this.points(trailer)) < 1e-6) {
      return { reason: "time limit, draw on points" };
    }
    return { winnerId: leader.id, reason: "time limit, decided on points" };
  }

  private points(aircraft: AircraftState): number {
    const score = this.scoring.get(aircraft.id)!;
    const opponent = this.state.aircraft.find((candidate) => candidate.id !== aircraft.id);
    const damageDealt = opponent ? 1 - opponent.damage.integrity : 0;
    return damageDealt * 100 + score.timeOnTargetS * 10 + score.timeInControlZoneS;
  }

  setHumanControls(aircraftId: string, controls: AircraftState["controls"]): void {
    const aircraft = this.state.aircraft.find((candidate) => candidate.id === aircraftId);
    if (aircraft) aircraft.controls = controls;
  }

  agentStats(): Record<string, AgentStats> {
    return Object.fromEntries(
      [...this.slots].map(([id, slot]) => [
        id,
        {
          info: slot.agent.info,
          decisions: slot.decisions,
          failures: slot.failures,
          timeouts: slot.timeouts,
          averageLatencyMs:
            slot.decisions + slot.failures ? slot.totalLatencyMs / (slot.decisions + slot.failures) : 0,
          maxLatencyMs: slot.maxLatencyMs,
          costUsd: slot.costUsd,
          inputTokens: slot.inputTokens,
          outputTokens: slot.outputTokens,
        },
      ]),
    );
  }

  /** True once any agent has spent more than the match's inference budget. */
  private overBudget(): string | undefined {
    for (const [aircraftId, slot] of this.slots) {
      if (slot.costUsd > this.inferenceBudgetUsd) return aircraftId;
    }
    return undefined;
  }

  /** Backwards-compatible alias. */
  latencyStats(): Record<string, { decisions: number; averageMs: number }> {
    return Object.fromEntries(
      Object.entries(this.agentStats()).map(([id, stats]) => [
        id,
        { decisions: stats.decisions, averageMs: stats.averageLatencyMs },
      ]),
    );
  }

  summary(): MatchSummary {
    return {
      scenarioId: this.config.id,
      seed: this.config.seed,
      durationS: this.state.time,
      winnerId: this.state.winnerId,
      reason: this.state.finishReason,
      aircraft: this.state.aircraft.map((aircraft) => {
        const score = this.scoring.get(aircraft.id)!;
        return {
          id: aircraft.id,
          team: aircraft.team,
          alive: aircraft.alive,
          health: aircraft.damage.integrity,
          hitsTaken: aircraft.damage.hitsTaken,
          hitsScored: score.hitsScored,
          roundsFired: score.roundsFired,
          ammoRemaining: aircraft.ammo,
          fuelRemainingKg: aircraft.engine.fuelKg,
          timeOnTargetS: score.timeOnTargetS,
          timeInControlZoneS: score.timeInControlZoneS,
          destroyedBy: aircraft.destroyedBy,
          destroyedReason: aircraft.destroyedReason,
        };
      }),
      agents: this.agentStats(),
    };
  }
}
