import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SCRIPTED_INFO } from "../../agents/agent";
import { EnergyFighterAgent } from "../../agents/baselines";
import { HttpAgent } from "../../agents/http-agent";
import { ReplayRecorder } from "../../sim/replay";
import { neutralMerge } from "../../sim/scenario";
import { DogfightSimulation } from "../../sim/simulation";
import type { ControlInput, MatchState } from "../../sim/types";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";

export type PilotKind = "human" | "basic" | "model";

/** How often the readouts a person looks at are refreshed, milliseconds. */
const UI_REFRESH_MS = 100;

export interface LiveMatch {
  /** Latest scene for the renderer. A ref, so drawing does not re-render React. */
  snapshotRef: RefObject<ViewerSnapshot | undefined>;
  /** Match state for the readouts, refreshed ten times a second. */
  state: MatchState | undefined;
  /** Simulated clock, updated every frame for the harness readouts. */
  simTimeRef: RefObject<number>;
  /** Live match state for overlays that draw every frame. */
  liveStateRef: RefObject<MatchState | undefined>;
  paused: boolean;
  timeScale: number;
  followRed: boolean;
  bluePilot: PilotKind;
  setPaused: (paused: boolean) => void;
  setTimeScale: (scale: number) => void;
  setFollowRed: (follow: boolean) => void;
  setBluePilot: (pilot: PilotKind) => void;
  restart: () => void;
  downloadReplay: () => void;
}

/**
 * Keyboard axes, as pairs of [positive, negative].
 *
 * Pitch follows the stick, not the camera: W is forward on the stick and puts
 * the nose down, S is back and pulls. The control input itself is a load-factor
 * command where positive pulls, so W maps to the negative end.
 */
const KEY_AXES = {
  pitch: ["KeyS", "KeyW"],
  roll: ["KeyD", "KeyA"],
  yaw: ["KeyE", "KeyQ"],
  throttle: ["KeyR", "KeyF"],
} as const;

/**
 * Owns the live simulation and its animation loop.
 *
 * The simulation is a mutable object stepped at 120 Hz and kept in a ref. The
 * renderer reads its scene from another ref every frame. React state is
 * refreshed only ten times a second, and only for the readouts a person
 * actually reads -- fast enough to look live, slow enough that reconciliation
 * is not the most expensive thing on the page.
 */
export function useLiveMatch(): LiveMatch {
  const simulation = useRef<DogfightSimulation>(undefined);
  const recorder = useRef<ReplayRecorder>(undefined);
  const accumulator = useRef(0);
  const lastFrame = useRef(performance.now());
  const keys = useRef(new Set<string>());
  const human = useRef<ControlInput>({ pitch: 0, roll: 0, yaw: 0, throttle: 0.85, fire: false });

  const snapshotRef = useRef<ViewerSnapshot>(undefined);
  const simTimeRef = useRef(0);
  const liveStateRef = useRef<MatchState>(undefined);
  const lastEventIndex = useRef(0);
  const lastUiUpdate = useRef(0);
  const [state, setState] = useState<MatchState>();
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState(1);
  const [followRed, setFollowRed] = useState(false);
  const [bluePilot, setBluePilot] = useState<PilotKind>("human");

  const pausedRef = useRef(paused);
  const scaleRef = useRef(timeScale);
  const pilotRef = useRef(bluePilot);
  pausedRef.current = paused;
  scaleRef.current = timeScale;
  pilotRef.current = bluePilot;

  const restart = useCallback(() => {
    const sim = new DogfightSimulation(neutralMerge, { decisionIntervalS: 0.25 });
    const pilot = pilotRef.current;
    if (pilot === "basic") sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
    if (pilot === "model") {
      sim.attachAgent(
        "blue-1",
        new HttpAgent(
          "blue-1",
          { name: "server model", provider: "server", model: "configured", policyVersion: "1", schema: "tactical" },
          "/api/decide",
        ),
      );
    }
    sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));

    simulation.current = sim;
    recorder.current = new ReplayRecorder(neutralMerge, {
      "blue-1": pilot === "human" ? SCRIPTED_INFO("human", "raw") : SCRIPTED_INFO(pilot),
      "red-1": SCRIPTED_INFO("energy-fighter"),
    });
    accumulator.current = 0;
    lastEventIndex.current = 0;
    setPaused(false);
  }, []);

  useEffect(() => restart(), [restart, bluePilot]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (["Space", "ArrowUp", "ArrowDown"].includes(event.code)) event.preventDefault();
      keys.current.add(event.code);
    };
    const up = (event: KeyboardEvent) => keys.current.delete(event.code);
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = (now: number) => {
      const wallDt = Math.min((now - lastFrame.current) / 1000, 0.1);
      lastFrame.current = now;
      const sim = simulation.current;

      if (sim && !pausedRef.current && !sim.state.finished) {
        accumulator.current += wallDt * scaleRef.current;

        if (pilotRef.current === "human") {
          const axis = (pair: readonly [string, string]) =>
            (keys.current.has(pair[0]) ? 1 : 0) - (keys.current.has(pair[1]) ? 1 : 0);
          human.current.pitch = axis(KEY_AXES.pitch);
          human.current.roll = axis(KEY_AXES.roll);
          human.current.yaw = axis(KEY_AXES.yaw);
          human.current.throttle = Math.max(
            0,
            Math.min(1, human.current.throttle + axis(KEY_AXES.throttle) * 0.006),
          );
          human.current.fire = keys.current.has("Space");
          sim.setHumanControls("blue-1", { ...human.current });
        }

        let safety = 0;
        while (accumulator.current >= neutralMerge.fixedDt && safety++ < 500) {
          sim.step();
          recorder.current?.capture(sim.state);
          accumulator.current -= neutralMerge.fixedDt;
        }
        if (sim.state.finished) recorder.current?.finish(sim.decisions, sim.summary());
      }

      if (sim) {
        snapshotRef.current = snapshotFromMatch(sim.state, lastEventIndex.current);
        liveStateRef.current = sim.state;
        lastEventIndex.current = sim.state.events.length;
        simTimeRef.current = sim.state.time;
        if (now - lastUiUpdate.current >= UI_REFRESH_MS) {
          lastUiUpdate.current = now;
          setState({ ...sim.state });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const downloadReplay = useCallback(() => {
    const sim = simulation.current;
    if (!recorder.current || !sim) return;
    recorder.current.finish(sim.decisions, sim.summary());
    const url = URL.createObjectURL(recorder.current.toBlob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `dogfight-${Date.now()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, []);

  return {
    snapshotRef,
    simTimeRef,
    liveStateRef,
    state,
    paused,
    timeScale,
    followRed,
    bluePilot,
    setPaused,
    setTimeScale,
    setFollowRed,
    setBluePilot,
    restart,
    downloadReplay,
  };
}
