import type { AgentAdapter } from "../agents/agent";
import { validateDecision } from "../agents/agent";
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
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastDecisionAt: number;
  lastEventIndex: number;
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
  decisions: number;
  failures: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
}

export class DogfightSimulation {
  readonly state: MatchState;
  private readonly rng: Random;
  private projectileId = 1;
  private readonly slots = new Map<string, AgentSlot>();
  private readonly bookkeeping = new Map<string, AircraftBookkeeping>();
  private readonly scoring = new Map<string, { roundsFired: number; hitsScored: number; timeOnTargetS: number; timeInControlZoneS: number }>();

  constructor(
    readonly config: ScenarioConfig,
    readonly decisionIntervalS = 0.25,
  ) {
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
    this.slots.set(aircraftId, {
      agent,
      nextDecisionAt: 0,
      sequence: 0,
      pending: false,
      decisions: 0,
      failures: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      lastDecisionAt: 0,
      lastEventIndex: 0,
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
      const request = slot.agent
        .decide(observation)
        .then((decision) => {
          const target = this.state.aircraft.find((candidate) => candidate.id === aircraftId);
          if (target?.alive) target.controls = validateDecision(decision).controls;
          slot.decisions += 1;
        })
        .catch(() => {
          // Hold the last valid controls; a model that fails does not get to
          // freeze the match, but the failure is recorded against it.
          slot.failures += 1;
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
    for (const aircraft of this.state.aircraft) {
      if (aircraft.alive && isDestroyed(aircraft.damage)) this.destroy(aircraft, "airframe destroyed");
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
          decisions: slot.decisions,
          failures: slot.failures,
          averageLatencyMs: slot.decisions + slot.failures ? slot.totalLatencyMs / (slot.decisions + slot.failures) : 0,
          maxLatencyMs: slot.maxLatencyMs,
        },
      ]),
    );
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
