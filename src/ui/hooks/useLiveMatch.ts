import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SCRIPTED_INFO, type AgentAdapter, type AgentInfo } from "../../agents/agent";
import { BasicPursuitAgent, EnergyFighterAgent } from "../../agents/baselines";
import { HttpAgent } from "../../agents/http-agent";
import { ReplayRecorder, type ReplayFile } from "../../sim/replay";
import { fox2Merge, neutralMerge } from "../../sim/scenario";
import { DogfightSimulation, type DecisionRecord } from "../../sim/simulation";
import type { Loadout, MatchState } from "../../sim/types";
import { AIRFRAME_IDS, type AirframeId } from "../../sim/airframes";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";
import { api } from "../api";
import { authConfigured, authHeaders } from "../auth";
import { keyHeaders } from "../keys";
import { useAccount } from "./useAccount";
import {
  PilotInput,
  loadSettings,
  saveSettings,
  type ControlScheme,
  type MouseMode,
  type PilotInputSettings,
} from "../input/pilot-input";

export type PilotChoice = string;

export const HUMAN: PilotChoice = "human";

export interface RecordingState {
  status: "idle" | "ranked" | "unranked" | "saving" | "saved" | "failed";
  message?: string;
}

const UI_REFRESH_MS = 100;

export interface LiveMatch {
  snapshotRef: RefObject<ViewerSnapshot | undefined>;
  state: MatchState | undefined;
  simTimeRef: RefObject<number>;
  liveStateRef: RefObject<MatchState | undefined>;
  decisions: Record<string, DecisionRecord | undefined>;
  recording: RecordingState;
  paused: boolean;
  timeScale: number;
  followRed: boolean;
  bluePilot: PilotChoice;
  redPilot: PilotChoice;
  weapons: Loadout;
  scheme: ControlScheme;
  inputSettings: PilotInputSettings;
  canCapturePointer: boolean;
  mouseMode: MouseMode;
  inputRef: RefObject<PilotInput>;
  setScheme: (scheme: ControlScheme) => void;
  setInputSettings: (settings: PilotInputSettings) => void;
  setPaused: (paused: boolean) => void;
  setTimeScale: (scale: number) => void;
  setFollowRed: (follow: boolean) => void;
  setBluePilot: (pilot: PilotChoice) => void;
  setRedPilot: (pilot: PilotChoice) => void;
  setWeapons: (weapons: Loadout) => void;
  restart: () => void;
  downloadReplay: () => void;
  /** The match so far as a replay, frozen at this moment, or nothing before the first frame. */
  replaySoFar: () => ReplayFile | undefined;
}

function infoFor(pilot: PilotChoice): AgentInfo {
  if (pilot === HUMAN) return SCRIPTED_INFO("human", "raw");
  if (pilot === "basic") return SCRIPTED_INFO("energy-fighter");
  if (pilot === "basic-pursuit") return SCRIPTED_INFO("basic-pursuit");
  return {
    name: pilot,
    provider: pilot,
    model: "server-configured",
    policyVersion: "1",
    schema: "tactical",
  };
}

function buildAgent(
  pilot: PilotChoice,
  aircraftId: string,
  matchId: () => string | undefined,
): AgentAdapter | undefined {
  if (pilot === HUMAN) return undefined;
  if (pilot === "basic") return new EnergyFighterAgent(aircraftId);
  if (pilot === "basic-pursuit") return new BasicPursuitAgent(aircraftId);
  return new HttpAgent(aircraftId, infoFor(pilot), "/api/decide", pilot, () => {
    const id = matchId();
    return { ...keyHeaders(pilot), ...(id ? { "x-match-id": id } : {}) };
  });
}

export interface MatchSetup {
  opponent?: PilotChoice;
  weapons?: Loadout;
  scheme?: ControlScheme;
  /** Your aeroplane; an F-16 when not said. */
  aircraft?: AirframeId;
  /** The enemy's: one of them, the same as yours, or a fresh pick at every restart. */
  enemyAircraft?: AirframeId | "same" | "random";
}

export function useLiveMatch(setup: MatchSetup = {}): LiveMatch {
  const account = useAccount();
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
  const [decisions, setDecisions] = useState<Record<string, DecisionRecord | undefined>>({});
  const [paused, setPaused] = useState(false);
  const [timeScale, setTimeScale] = useState(1);
  const [followRed, setFollowRed] = useState(false);
  const [bluePilot, setBluePilot] = useState<PilotChoice>(HUMAN);
  const [redPilot, setRedPilot] = useState<PilotChoice>(setup.opponent ?? "basic");
  const [weapons, setWeapons] = useState<Loadout>(setup.weapons ?? "guns");
  const [scheme, setSchemeState] = useState<ControlScheme>(() => {
    const initial = setup.scheme ?? "keyboard";
    input.current.scheme = initial;
    return initial;
  });
  const [inputSettings, setInputSettingsState] = useState<PilotInputSettings>(() => loadSettings());
  const [canCapturePointer, setCanCapturePointer] = useState(false);
  const [mouseMode, setMouseMode] = useState<MouseMode>("absolute");
  const [recording, setRecording] = useState<RecordingState>({ status: "idle" });
  const matchTicket = useRef<{ id: string; ranked: boolean } | undefined>(undefined);
  const reported = useRef(false);

  const pausedRef = useRef(paused);
  const scaleRef = useRef(timeScale);
  const bluePilotRef = useRef(bluePilot);
  const redPilotRef = useRef(redPilot);
  const weaponsRef = useRef(weapons);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  pausedRef.current = paused;
  scaleRef.current = timeScale;
  bluePilotRef.current = bluePilot;
  redPilotRef.current = redPilot;
  weaponsRef.current = weapons;

  const restart = useCallback(() => {
    const blue = bluePilotRef.current;
    const red = redPilotRef.current;

    const usesModel = [blue, red].some(
      (pilot) => pilot !== HUMAN && pilot !== "basic" && pilot !== "basic-pursuit",
    );
    const base = weaponsRef.current === "fox2" ? fox2Merge : neutralMerge;
    const mine = setupRef.current.aircraft ?? "f16c";
    const wanted = setupRef.current.enemyAircraft ?? "same";
    const theirs =
      wanted === "same"
        ? mine
        : wanted === "random"
          ? AIRFRAME_IDS[Math.floor(Math.random() * AIRFRAME_IDS.length)]!
          : wanted;
    const scenario = { ...base, airframes: { "blue-1": mine, "red-1": theirs } };
    const sim = new DogfightSimulation(scenario, { decisionIntervalS: usesModel ? 1 : 0.25 });

    const ticketId = () => matchTicket.current?.id;
    const blueAgent = buildAgent(blue, "blue-1", ticketId);
    if (blueAgent) sim.attachAgent("blue-1", blueAgent);
    const redAgent = buildAgent(red, "red-1", ticketId);
    if (redAgent) sim.attachAgent("red-1", redAgent);

    simulation.current = sim;
    recorder.current = new ReplayRecorder(scenario, {
      "blue-1": infoFor(blue),
      "red-1": infoFor(red),
    });
    accumulator.current = 0;
    lastEventIndex.current = 0;
    input.current.reset();
    matchTicket.current = undefined;
    reported.current = false;
    setDecisions({});
    setRecording({ status: "idle" });
    setPaused(false);

    if (scenario.weapons === "fox2") {
      // The ladder is a guns-only ladder; a missile fight is not the same contest.
      if (blue === HUMAN) setRecording({ status: "unranked", message: "Fox 2 · not ranked" });
    } else if (!authConfigured) {
      if (blue === HUMAN) {
        setRecording({ status: "unranked", message: "Not recorded" });
      }
    } else if (blue === HUMAN && red !== HUMAN) {
      void authHeaders()
        .then((headers) => api.startLiveMatch(red, headers))
        .then((ticket) => {
          matchTicket.current = { id: ticket.matchId, ranked: ticket.ranked };
          setRecording({
            status: ticket.ranked ? "ranked" : "unranked",
            message: ticket.ranked ? undefined : "Not counted · sign in to rank",
          });
        })
        .catch(() => {
          setRecording({ status: "unranked", message: "Not recorded" });
        });
    }
  }, []);

  useEffect(() => restart(), [restart, bluePilot, redPilot, weapons, account.user?.id]);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>("#viewport") ?? document.body;
    const detach = input.current.attach(host);
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

        if (bluePilotRef.current === HUMAN) {
          sim.setHumanControls("blue-1", input.current.sample(wallDt));
        }

        let safety = 0;
        while (accumulator.current >= neutralMerge.fixedDt && safety++ < 500) {
          sim.step();
          recorder.current?.capture(sim.state);
          accumulator.current -= neutralMerge.fixedDt;
        }
        if (sim.state.finished) {
          recorder.current?.finish(sim.decisions, sim.summary());
          void reportResult(sim);
        }
      }

      if (sim) {
        snapshotRef.current = snapshotFromMatch(sim.state, lastEventIndex.current);
        liveStateRef.current = sim.state;
        lastEventIndex.current = sim.state.events.length;
        simTimeRef.current = sim.state.time;
        if (now - lastUiUpdate.current >= UI_REFRESH_MS) {
          lastUiUpdate.current = now;
          setState({ ...sim.state });
          setDecisions({
            "blue-1": sim.latestDecision("blue-1"),
            "red-1": sim.latestDecision("red-1"),
          });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const reportResult = useCallback(async (sim: DogfightSimulation) => {
    const ticket = matchTicket.current;
    if (!ticket || reported.current) return;
    reported.current = true;

    if (!ticket.ranked) {
      setRecording({ status: "unranked", message: "Not counted · sign in to rank" });
      return;
    }

    setRecording({ status: "saving" });
    try {
      recorder.current?.finish(sim.decisions, sim.summary());
      const outcome = await api.reportLiveMatch(
        ticket.id,
        {
          summary: sim.summary(),
          humanAircraftId: "blue-1",
          ...(recorder.current ? { replay: recorder.current.toJSON() } : {}),
        },
        await authHeaders(),
      );
      setRecording({
        status: "saved",
        message: outcome.provisional ? "Recorded · attach an account to rank" : "Recorded",
      });
    } catch (cause: unknown) {
      setRecording({ status: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
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

  const replaySoFar = useCallback((): ReplayFile | undefined => {
    const sim = simulation.current;
    const recording = recorder.current;
    if (!sim || !recording) return undefined;
    // The recorder keeps only every few ticks; the present moment goes in too,
    // so the replay runs right up to where the pause or the kill happened.
    recording.captureNow(sim.state);
    const replay = recording.replay;
    return {
      ...replay,
      frames: [...replay.frames],
      events: [...replay.events],
      decisions: [...sim.decisions],
      summary: sim.state.finished ? sim.summary() : undefined,
    };
  }, []);

  return {
    snapshotRef,
    simTimeRef,
    liveStateRef,
    state,
    decisions,
    recording,
    paused,
    timeScale,
    followRed,
    bluePilot,
    redPilot,
    weapons,
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
    setRedPilot,
    setWeapons,
    restart,
    downloadReplay,
    replaySoFar,
  };
}
