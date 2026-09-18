import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SCRIPTED_INFO } from "../../agents/agent";
import { EnergyFighterAgent } from "../../agents/baselines";
import { HttpAgent } from "../../agents/http-agent";
import { ReplayRecorder } from "../../sim/replay";
import { neutralMerge } from "../../sim/scenario";
import { DogfightSimulation } from "../../sim/simulation";
import type { MatchState } from "../../sim/types";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";
import {
  PilotInput,
  loadSettings,
  saveSettings,
  type ControlScheme,
  type MouseMode,
  type PilotInputSettings,
} from "../input/pilot-input";

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
  /** Which device is flying the blue jet. */
  scheme: ControlScheme;
  inputSettings: PilotInputSettings;
  /** True when the pointer could still be captured for a free-moving stick. */
  canCapturePointer: boolean;
  /** How the mouse is being read right now. */
  mouseMode: MouseMode;
  /** Live stick position for the control indicator; read every frame. */
  inputRef: RefObject<PilotInput>;
  setScheme: (scheme: ControlScheme) => void;
  setInputSettings: (settings: PilotInputSettings) => void;
  setPaused: (paused: boolean) => void;
  setTimeScale: (scale: number) => void;
  setFollowRed: (follow: boolean) => void;
  setBluePilot: (pilot: PilotKind) => void;
  restart: () => void;
  downloadReplay: () => void;
}

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
  const input = useRef<PilotInput>(undefined as unknown as PilotInput);
  if (!input.current) input.current = new PilotInput();

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
  const [scheme, setSchemeState] = useState<ControlScheme>("keyboard");
  const [inputSettings, setInputSettingsState] = useState<PilotInputSettings>(() => loadSettings());
  const [canCapturePointer, setCanCapturePointer] = useState(false);
  const [mouseMode, setMouseMode] = useState<MouseMode>("absolute");

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
    input.current.reset();
    setPaused(false);
  }, []);

  useEffect(() => restart(), [restart, bluePilot]);

  /**
   * Bind the devices to the viewport.
   *
   * The pointer has to be captured on the element the person actually clicked,
   * so this waits for the canvas host to exist rather than listening on the
   * document and hoping.
   */
  useEffect(() => {
    const host = document.querySelector<HTMLElement>("#viewport") ?? document.body;
    const detach = input.current.attach(host);
    // Pointer lock can be lost without warning -- Escape, a window switch, the
    // browser deciding it has had enough -- and there is no single event that
    // covers every case, so the visible state is polled rather than inferred.
    const poll = setInterval(() => {
      setCanCapturePointer(input.current.canCapturePointer);
      setMouseMode(input.current.mouseMode);
    }, 250);
    return () => {
      detach();
      clearInterval(poll);
    };
  }, []);

  const setScheme = useCallback((next: ControlScheme) => {
    input.current.scheme = next;
    input.current.reset();
    if (next !== "mouse") input.current.releasePointerLock();
    setSchemeState(next);
    setCanCapturePointer(input.current.canCapturePointer);
    setMouseMode(input.current.mouseMode);
  }, []);

  const setInputSettings = useCallback((next: PilotInputSettings) => {
    input.current.settings = next;
    saveSettings(next);
    setInputSettingsState(next);
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
          sim.setHumanControls("blue-1", input.current.sample(wallDt));
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
    scheme,
    inputSettings,
    canCapturePointer,
    mouseMode,
    inputRef: input,
    setScheme,
    setInputSettings,
    setPaused,
    setTimeScale,
    setFollowRed,
    setBluePilot,
    restart,
    downloadReplay,
  };
}
