import { useEffect, useMemo, useRef, useState } from "react";
import type { ReplayFile } from "../../sim/replay";
import type { ViewerSnapshot } from "../../viewer";

/**
 * Plays a recorded replay back at a chosen speed.
 *
 * Frames are stored at a fixed cadence, so playback interpolates between the
 * two frames bracketing the current time; without that, a replay recorded at
 * 30 Hz visibly stutters on a 120 Hz display.
 *
 * The scene goes to the renderer through a ref and advances every frame, while
 * the clock that drives the scrubber is React state refreshed ten times a
 * second. Rendering and re-rendering are separate problems.
 */
const UI_REFRESH_MS = 100;

export function useReplayPlayback(replay: ReplayFile | undefined) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const last = useRef(performance.now());
  const clock = useRef(0);
  const lastUiUpdate = useRef(0);
  const snapshotRef = useRef<ViewerSnapshot>(undefined);

  const duration = useMemo(() => replay?.frames.at(-1)?.t ?? 0, [replay]);

  useEffect(() => {
    clock.current = 0;
    setTime(0);
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
      if (now - lastUiUpdate.current >= UI_REFRESH_MS) {
        lastUiUpdate.current = now;
        setTime(clock.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration, replay]);

  return { snapshotRef, time, setTime: seek, duration, playing, setPlaying, speed, setSpeed };
}

/** Interpolated scene at an arbitrary time within a replay. */
export function sampleAt(replay: ReplayFile | undefined, time: number): ViewerSnapshot | undefined {
  {
    if (!replay?.frames.length) return undefined;
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
    const blend = span > 1e-6 ? Math.min(1, Math.max(0, (time - current.t) / span)) : 0;

    // Impacts land within a frame of the event, so effects fire in playback too.
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
      aircraft: current.aircraft.map((aircraft, position) => {
        const later = next.aircraft[position] ?? aircraft;
        return {
          id: aircraft.id,
          team: aircraft.id.startsWith("red") ? ("red" as const) : ("blue" as const),
          position: lerp3(aircraft.p, later.p, blend),
          orientation: slerpish(aircraft.q, later.q, blend),
          alive: aircraft.alive,
          integrity: aircraft.health,
        };
      }),
      tracers: (current.projectiles ?? []).map((position) => ({ p: position })),
    };
  }
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Normalised linear interpolation between quaternions.
 *
 * Frames are close enough together that nlerp and slerp are visually identical,
 * and this avoids the trigonometry on every frame. The sign flip matters: two
 * quaternions can describe the same rotation with opposite signs, and blending
 * across that boundary spins the aircraft the long way round.
 */
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
