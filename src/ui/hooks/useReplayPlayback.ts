import { useEffect, useMemo, useRef, useState } from "react";
import { Quaternion, Vector3 } from "three";
import { atmosphere } from "../../sim/atmosphere";
import { MASS, MISSILE } from "../../sim/config";
import { createDamageState } from "../../sim/damage";
import { createFlcsState } from "../../sim/flcs";
import { heightAboveGround } from "../../sim/terrain";
import { SEEKER_TONES, type ReplayFile, type ReplayFrame } from "../../sim/replay";
import type { AircraftState, FlareState, MatchState, MissileState } from "../../sim/types";
import { burstsFrom, railsLoaded, type ViewerSnapshot } from "../../viewer";
import { radians } from "../../math";

const UI_REFRESH_MS = 100;

export function useReplayPlayback(replay: ReplayFile | undefined) {
  const [time, setTime] = useState(0);
  const [state, setState] = useState<MatchState>();
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = useRef(performance.now());
  const clock = useRef(0);
  const lastUiUpdate = useRef(0);
  const snapshotRef = useRef<ViewerSnapshot>(undefined);
  const stateRef = useRef<MatchState>(undefined);

  const duration = useMemo(() => replay?.frames.at(-1)?.t ?? 0, [replay]);

  useEffect(() => {
    clock.current = 0;
    setTime(0);
    setState(undefined);
    setPlaying(true);
  }, [replay]);

  const seek = (value: number) => {
    clock.current = value;
    setTime(value);
  };

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const delta = Math.min((now - last.current) / 1000, 0.25);
      last.current = now;
      if (playing && duration > 0) {
        clock.current = Math.min(duration, clock.current + delta * speed);
      }
      snapshotRef.current = sampleAt(replay, clock.current);
      stateRef.current = replay ? rebuildState(replay, clock.current) : undefined;
      if (now - lastUiUpdate.current >= UI_REFRESH_MS) {
        lastUiUpdate.current = now;
        setTime(clock.current);
        setState(stateRef.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, replay]);

  return { snapshotRef, stateRef, state, time, setTime: seek, duration, playing, setPlaying, speed, setSpeed };
}

export function sampleAt(replay: ReplayFile | undefined, time: number): ViewerSnapshot | undefined {
  if (!replay?.frames.length) return undefined;
  const { current, next, blend } = bracket(replay, time);

  const window = 0.2;
  const positions = new Map(current.aircraft.map((aircraft) => [aircraft.id, aircraft.p]));
  const impacts = replay.events
    .filter(
      (event) =>
        (event.type === "hit" || event.type === "kill" || event.type === "ground-impact") &&
        Math.abs(event.time - time) < window,
    )
    .map((event) => positions.get(event.targetId ?? event.actorId ?? ""))
    .filter((position): position is [number, number, number] => position !== undefined);

  return {
    time,
    impacts,
    aircraft: current.aircraft.map((aircraft, index) => {
      const later = next.aircraft[index] ?? aircraft;
      return {
        id: aircraft.id,
        team: aircraft.id.startsWith("red") ? ("red" as const) : ("blue" as const),
        position: lerp3(aircraft.p, later.p, blend),
        orientation: slerpish(aircraft.q, later.q, blend),
        alive: aircraft.alive,
        integrity: aircraft.health,
        afterburner: (aircraft.s?.[4] ?? 0) === 1,
        rails: railsLoaded(aircraft.m ? MISSILE.carried : 0, aircraft.m?.[0] ?? 0),
      };
    }),
    tracers: (current.projectiles ?? []).map((segment) => ({
      from: [segment[0], segment[1], segment[2]] as [number, number, number],
      to: [segment[3], segment[4], segment[5]] as [number, number, number],
    })),
    // Carried forward along their velocity rather than blended: the frames
    // are a few hundredths of a second apart and a missile does not turn much
    // in that, while missiles appearing and vanishing between frames would
    // pair the wrong ones up.
    missiles: (current.missiles ?? []).map(([x, y, z, vx, vy, vz, motor], index) => {
      const ahead = time - current.t;
      return {
        id: index,
        position: [x + vx * ahead, y + vy * ahead, z + vz * ahead] as [number, number, number],
        velocity: [vx, vy, vz] as [number, number, number],
        motor: motor === 1,
      };
    }),
    flares: current.flares ?? [],
    bursts: burstsFrom(replay.events.filter((event) => Math.abs(event.time - time) < window)),
  };
}

function bracket(replay: ReplayFile, time: number): { current: ReplayFrame; next: ReplayFrame; blend: number } {
  const frames = replay.frames;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (frames[middle]!.t < time) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const current = frames[index]!;
  const next = frames[Math.min(index + 1, frames.length - 1)]!;
  const span = next.t - current.t;
  return { current, next, blend: span > 1e-6 ? Math.min(1, Math.max(0, (time - current.t) / span)) : 0 };
}

function rebuildState(replay: ReplayFile, time: number): MatchState {
  const { current, next, blend } = bracket(replay, time);
  return {
    time,
    tick: current.tick,
    finished: false,
    events: replay.events.filter((event) => event.time <= time),
    projectiles: [],
    missiles: (current.missiles ?? []).map(
      ([x, y, z, vx, vy, vz, motor, team], index): MissileState => ({
        id: index,
        ownerId: team === 1 ? "red-1" : "blue-1",
        position: new Vector3(x, y, z),
        previousPosition: new Vector3(x, y, z),
        velocity: new Vector3(vx, vy, vz),
        age: 0,
        motorRemainingS: motor === 1 ? MISSILE.burnS : 0,
        massKg: MISSILE.launchMassKg,
        flaresSeen: [],
      }),
    ),
    flares: (current.flares ?? []).map(
      ([x, y, z], index): FlareState => ({
        id: index,
        ownerId: "",
        position: new Vector3(x, y, z),
        velocity: new Vector3(),
        age: 0,
      }),
    ),
    aircraft: current.aircraft.map((frame, index) => {
      const later = next.aircraft[index] ?? frame;
      const [aoaDeg, loadFactor, fuelKg, throttle, afterburner, limiter, departed] = frame.s ?? [
        0, 1, 0, 0, 0, 0, 0,
      ];
      const [missiles, flares, tone] = frame.m ?? [0, 0, 0];
      const position = new Vector3(...lerp3(frame.p, later.p, blend));
      const velocity = new Vector3(...lerp3(frame.v, later.v, blend));
      const air = atmosphere(position.y);

      const aircraft: AircraftState = {
        id: frame.id,
        team: frame.id.startsWith("red") ? "red" : "blue",
        position,
        velocity,
        acceleration: new Vector3(),
        orientation: new Quaternion(...slerpish(frame.q, later.q, blend)),
        angularVelocity: new Vector3(),
        controls: { pitch: 0, roll: 0, yaw: 0, throttle, fire: false },
        commandedControls: { pitch: 0, roll: 0, yaw: 0, throttle, fire: false },
        flcs: { ...createFlcsState(), limiterActive: limiter === 1, departed: departed === 1 },
        engine: {
          power: throttle,
          fuelKg,
          thrustN: 0,
          fuelFlowKgS: 0,
          afterburner: afterburner === 1,
        },
        massKg: MASS.emptyKg + fuelKg,
        aoaRad: radians(aoaDeg),
        sideslipRad: 0,
        loadFactor,
        mach: velocity.length() / air.speedOfSoundMps,
        specificExcessPowerMps: 0,
        heightAboveGroundM: heightAboveGround(position.x, position.y, position.z),
        ammo: frame.ammo,
        gunAccumulator: 0,
        gunSpin: 0,
        roundsThisBurst: 0,
        stores: {
          missileStations: frame.m ? MISSILE.carried : 0,
          missiles,
          flares,
          missileHeld: false,
          flareHeld: false,
          salvoRemaining: 0,
          salvoTimerS: 0,
          launchCooldownS: 0,
        },
        seeker: { tone: SEEKER_TONES[tone] ?? "off", signal: 0, flaresSeen: [] },
        damage: { ...createDamageState(), integrity: frame.health },
        health: frame.health,
        alive: frame.alive,
      };
      return aircraft;
    }),
  };
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function slerpish(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  const out: [number, number, number, number] = [
    a[0] + (b[0] * sign - a[0]) * t,
    a[1] + (b[1] * sign - a[1]) * t,
    a[2] + (b[2] * sign - a[2]) * t,
    a[3] + (b[3] * sign - a[3]) * t,
  ];
  const length = Math.hypot(...out) || 1;
  return [out[0] / length, out[1] / length, out[2] / length, out[3] / length];
}
