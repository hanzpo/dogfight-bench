import type { AgentAdapter, AgentInfo, ChoiceDistribution, DecisionUsage } from "../agents/agent";
import { AgentTimeoutError, decideWithTimeout, resolveAction, validateDecision } from "../agents/agent";
import type { AgentAction, TacticalAction } from "../agents/action";
import { contextFromState, resolveTactical } from "../agents/autopilot";
import { isDestroyed } from "./damage";
import { stepAircraft } from "./flight-model";
import { fireGun, stepProjectiles } from "./gun";
import { dispenseFlares, launchMissile, stepFlares, stepMissiles, updateSeeker } from "./missile";
import { Random, mixSeed } from "./random";
import { createNeutralMerge } from "./scenario";
import { terrainHeight } from "./terrain";
import { observationFor } from "./telemetry";
import {
  packRounds,
  reviveAircraft,
  reviveFlares,
  reviveMissiles,
  toPlain,
  unpackRounds,
  type SimSnapshot,
} from "./snapshot";
import type { AircraftState, MatchState, ProjectileState, ScenarioConfig, SimEvent } from "./types";

const BOUNDARY_GRACE_S = 5;
const BINGO_FUEL_KG = 450;

const LEVEL: TacticalAction = { schema: "tactical", maneuver: "level", targetG: 1, throttle: "mil", fire: false };

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

export interface DecisionRecord {
  tick: number;
  time: number;
  aircraftId: string;
  sequence: number;
  action: AgentAction;
  rationale?: string;
  latencyMs: number;
  usage?: DecisionUsage;
  distributions?: ChoiceDistribution[];
  error?: string;
}

export interface SimulationOptions {
  decisionIntervalS?: number;
  decisionTimeoutMs?: number;
  inferenceBudgetUsd?: number;
  recordDecisions?: boolean;
}

interface AircraftBookkeeping {
  outsideArenaFor: number;
  belowDeckFor: number;
  bingoCalled: boolean;
  wasDeparted: boolean;
}

interface Scoring {
  roundsFired: number;
  hitsScored: number;
  missilesFired: number;
  timeOnTargetS: number;
  timeInControlZoneS: number;
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
    missilesFired?: number;
    ammoRemaining: number;
    fuelRemainingKg: number;
    timeOnTargetS: number;
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
  /**
   * Its own stream, so that a fight with missiles in it draws nothing from the
   * gun's dispersion and a guns-only fight replays exactly as it always did.
   */
  private readonly missileRng: Random;
  private projectileId = 1;
  private storeId = 1;
  private readonly slots = new Map<string, AgentSlot>();
  private readonly standingOrders = new Map<string, TacticalAction>();
  private readonly bookkeeping = new Map<string, AircraftBookkeeping>();
  private readonly scoring = new Map<string, Scoring>();

  readonly decisionIntervalS: number;
  readonly decisionTimeoutMs: number;
  readonly inferenceBudgetUsd: number;
  readonly decisions: DecisionRecord[] = [];
  private readonly lastDecisions = new Map<string, DecisionRecord>();
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
    this.missileRng = new Random(mixSeed(config.seed ^ 0x5a17_f0c5));
    for (const aircraft of this.state.aircraft) {
      this.bookkeeping.set(aircraft.id, {
        outsideArenaFor: 0,
        belowDeckFor: 0,
        bingoCalled: false,
        wasDeparted: false,
      });
      this.scoring.set(aircraft.id, {
        roundsFired: 0,
        hitsScored: 0,
        missilesFired: 0,
        timeOnTargetS: 0,
        timeInControlZoneS: 0,
      });
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
          if (target?.alive) {
            if (decision.action.schema === "tactical") {
              if (decision.action.schema === "tactical") this.standingOrders.set(aircraftId, decision.action);
              else this.standingOrders.delete(aircraftId);
            } else {
              this.standingOrders.delete(aircraftId);
              target.commandedControls = resolveAction(decision.action, observation);
            }
          }
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
            ...(decision.distributions ? { distributions: decision.distributions } : {}),
          });
        })
        .catch((error: unknown) => {
          slot.failures += 1;
          if (error instanceof AgentTimeoutError) slot.timeouts += 1;
          this.record({
            tick: this.state.tick,
            time: this.state.time,
            aircraftId,
            sequence,
            // What the aircraft goes on flying: a failed decision leaves the
            // standing order in place rather than changing anything.
            action: this.standingOrders.get(aircraftId) ?? LEVEL,
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
    this.lastDecisions.set(decision.aircraftId, decision);
    if (this.recordDecisions) this.decisions.push(decision);
  }

  latestDecision(aircraftId: string): DecisionRecord | undefined {
    return this.lastDecisions.get(aircraftId);
  }

  step(): MatchState {
    if (this.state.finished) return this.state;
    this.requestDecisions();
    return this.stepPhysics();
  }

  private flyStandingOrders(): void {
    if (!this.standingOrders.size) return;
    for (const aircraft of this.state.aircraft) {
      const order = this.standingOrders.get(aircraft.id);
      if (!order || !aircraft.alive) continue;
      const opponent = this.state.aircraft.find((candidate) => candidate.id !== aircraft.id);
      if (!opponent) continue;
      aircraft.commandedControls = resolveTactical(order, contextFromState(aircraft, opponent, this.config.hardDeckAglM));
    }
  }

  private stepPhysics(): MatchState {
    const dt = this.config.fixedDt;
    const eventCount = this.state.events.length;
    this.flyStandingOrders();

    for (const aircraft of this.state.aircraft) {
      const ammoBefore = aircraft.ammo;
      stepAircraft(aircraft, dt);
      fireGun(this.state, aircraft, dt, this.rng, () => this.projectileId++);
      this.scoring.get(aircraft.id)!.roundsFired += ammoBefore - aircraft.ammo;
      updateSeeker(this.state, aircraft, this.missileRng);
      if (launchMissile(this.state, aircraft, dt, () => this.storeId++)) {
        this.scoring.get(aircraft.id)!.missilesFired += 1;
      }
      dispenseFlares(this.state, aircraft, dt, () => this.storeId++);
      this.trackAircraft(aircraft, dt);
    }

    stepProjectiles(this.state, dt, this.rng);
    stepFlares(this.state, dt);
    stepMissiles(this.state, dt, this.missileRng);
    for (const event of this.state.events.slice(eventCount)) {
      if (event.type === "hit" && event.actorId) this.scoring.get(event.actorId)!.hitsScored += 1;
    }
    this.trackPositionalScore(dt);

    this.state.time += dt;
    this.state.tick += 1;
    this.finishIfNeeded();
    return this.state;
  }

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
      if (!aircraft.alive || !isDestroyed(aircraft.damage)) continue;
      // Damage that kills a moment after the hit -- a fire, a fuel leak -- is still that weapon's kill.
      this.destroy(aircraft, aircraft.damage.pilotIncapacitated ? "pilot incapacitated" : "airframe destroyed");
      aircraft.destroyedWeapon = aircraft.lastHit;
      aircraft.destroyedBy = aircraft.lastHit?.by;
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

  /**
   * The whole simulation at this tick, for another copy to carry on from.
   * Events travel separately; `rounds` narrows which rounds are packed, for a
   * sender that has already sent the rest.
   */
  snapshot(rounds: readonly ProjectileState[] = this.state.projectiles): SimSnapshot {
    const state = this.state;
    return {
      tick: state.tick,
      time: state.time,
      finished: state.finished,
      ...(state.winnerId !== undefined ? { winnerId: state.winnerId } : {}),
      ...(state.finishReason !== undefined ? { finishReason: state.finishReason } : {}),
      aircraft: state.aircraft.map(toPlain),
      missiles: state.missiles.map(toPlain),
      flares: state.flares.map(toPlain),
      rounds: packRounds(rounds, state.aircraft),
      rng: this.rng.save(),
      missileRng: this.missileRng.save(),
      projectileId: this.projectileId,
      storeId: this.storeId,
      bookkeeping: [...this.bookkeeping].map(([id, book]) => [id, { ...book }]),
      scoring: [...this.scoring].map(([id, score]) => [id, { ...score }]),
      eventCount: state.events.length,
    };
  }

  /**
   * Puts the simulation back to a snapshot. `events` is everything that had
   * happened by then, which the snapshot leaves out because it only grows;
   * `rounds`, when given, are the rounds in the air in place of the packed ones.
   */
  restore(snapshot: SimSnapshot, events: readonly SimEvent[], rounds?: readonly ProjectileState[]): void {
    const state = this.state;
    state.tick = snapshot.tick;
    state.time = snapshot.time;
    state.finished = snapshot.finished;
    state.winnerId = snapshot.winnerId;
    state.finishReason = snapshot.finishReason;
    state.aircraft = reviveAircraft(snapshot.aircraft);
    state.missiles = reviveMissiles(snapshot.missiles);
    state.flares = reviveFlares(snapshot.flares);
    state.projectiles = rounds
      ? rounds.map((round) => ({
          ...round,
          position: round.position.clone(),
          previousPosition: round.previousPosition.clone(),
          velocity: round.velocity.clone(),
        }))
      : unpackRounds(snapshot.rounds, state.aircraft);
    state.events = events.slice(0, snapshot.eventCount);
    this.rng.load(snapshot.rng);
    this.missileRng.load(snapshot.missileRng);
    this.projectileId = snapshot.projectileId;
    this.storeId = snapshot.storeId;
    for (const [id, book] of snapshot.bookkeeping) this.bookkeeping.set(id, { ...(book as AircraftBookkeeping) });
    for (const [id, score] of snapshot.scoring) this.scoring.set(id, { ...(score as Scoring) });
  }

  setHumanControls(aircraftId: string, controls: AircraftState["controls"]): void {
    const aircraft = this.state.aircraft.find((candidate) => candidate.id === aircraftId);
    if (!aircraft) return;
    this.standingOrders.delete(aircraftId);
    aircraft.commandedControls = controls;
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

  private overBudget(): string | undefined {
    for (const [aircraftId, slot] of this.slots) {
      if (slot.costUsd > this.inferenceBudgetUsd) return aircraftId;
    }
    return undefined;
  }

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
          ...(aircraft.stores.missileStations ? { missilesFired: score.missilesFired } : {}),
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
