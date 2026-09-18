import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { SCRIPTED_INFO, type AgentAdapter, type AgentInfo } from "../../agents/agent";
import { BasicPursuitAgent, EnergyFighterAgent } from "../../agents/baselines";
import { HttpAgent } from "../../agents/http-agent";
import { ReplayRecorder } from "../../sim/replay";
import { neutralMerge } from "../../sim/scenario";
import { DogfightSimulation, type DecisionRecord } from "../../sim/simulation";
import type { MatchState } from "../../sim/types";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";
import { api } from "../api";
import { authHeaders } from "../auth";
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

/**
 * Who is flying one aircraft.
 *
 * `human` is the person at the keyboard. `basic` and `basic-pursuit` are the
 * scripted baselines. Anything else is a provider name the server knows, flown
 * through `/api/decide` -- so adding a model to the server adds it here without
 * a change on this side.
 */
export type PilotChoice = string;

export const HUMAN: PilotChoice = "human";

/**
 * Whether a finished match went anywhere.
 *
 * A result only counts when the server issued a ticket for the match and served
 * the decisions itself, which is what stops anybody reporting a win against a
 * model they never called.
 */
export interface RecordingState {
  status: "idle" | "ranked" | "unranked" | "saving" | "saved" | "failed";
  message?: string;
}

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
  /** Most recent decision per aircraft, for the observer panel. */
  decisions: Record<string, DecisionRecord | undefined>;
  /** How the finished match was recorded, if it was. */
  recording: RecordingState;
  paused: boolean;
  timeScale: number;
  followRed: boolean;
  bluePilot: PilotChoice;
  redPilot: PilotChoice;
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
  restart: () => void;
  downloadReplay: () => void;
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

/**
 * Builds whatever flies one aircraft, or nothing at all for a person.
 *
 * A model agent reads its credentials at request time rather than capture time,
 * so entering a key mid-match takes effect on the next decision.
 */
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
    // The ticket goes out with every decision, so the server can count what it
    // actually flew for this match.
    return { ...keyHeaders(pilot), ...(id ? { "x-match-id": id } : {}) };
  });
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
  const [redPilot, setRedPilot] = useState<PilotChoice>("basic");
  const [scheme, setSchemeState] = useState<ControlScheme>("keyboard");
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
  pausedRef.current = paused;
  scaleRef.current = timeScale;
  bluePilotRef.current = bluePilot;
  redPilotRef.current = redPilot;

  const restart = useCallback(() => {
    const sim = new DogfightSimulation(neutralMerge, { decisionIntervalS: 0.25 });
    const blue = bluePilotRef.current;
    const red = redPilotRef.current;

    const ticketId = () => matchTicket.current?.id;
    const blueAgent = buildAgent(blue, "blue-1", ticketId);
    if (blueAgent) sim.attachAgent("blue-1", blueAgent);
    const redAgent = buildAgent(red, "red-1", ticketId);
    if (redAgent) sim.attachAgent("red-1", redAgent);

    simulation.current = sim;
    recorder.current = new ReplayRecorder(neutralMerge, {
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

    /**
     * Ask the server to open a match, but do not wait for it.
     *
     * The aircraft should be flying the instant the page is ready; a round trip
     * to open a ticket is not a reason to stare at a frozen merge. Any decision
     * that goes out before the ticket lands simply is not counted against it,
     * which costs a fraction of a second of credit at the very start.
     */
    // Any opponent that is not another person: beating the scripted baseline is
    // a real result and the obvious way onto the ladder without spending
    // anything on inference.
    if (blue === HUMAN && red !== HUMAN) {
      void authHeaders()
        .then((headers) => api.startLiveMatch(red, headers))
        .then((ticket) => {
          matchTicket.current = { id: ticket.matchId, ranked: ticket.ranked };
          setRecording({
            status: ticket.ranked ? "ranked" : "unranked",
            message: ticket.ranked
              ? undefined
              : "Sign in to have this count on the leaderboard and to keep the replay.",
          });
        })
        .catch(() => {
          // A server that cannot open a ticket is a server that cannot record
          // the result either. The match still flies.
          setRecording({ status: "unranked", message: "This match will not be recorded." });
        });
    }
  }, []);

  /**
   * Restart when the pilots change, and when who is flying changes.
   *
   * A ticket is issued once, at the start, and carries whether the result will
   * count. Signing in half way through a match cannot retroactively make that
   * match ranked, so start a fresh one -- otherwise somebody signs in, flies a
   * good fight and is told at the end that it did not count.
   */
  useEffect(() => restart(), [restart, bluePilot, redPilot, account.user?.id]);

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

  /**
   * Reports a finished match, once.
   *
   * Only for a match the server issued a ticket for: a scripted opponent has
   * nothing to verify against, so recording it would put unverifiable results
   * on a public board for no benefit.
   */
  const reportResult = useCallback(async (sim: DogfightSimulation) => {
    const ticket = matchTicket.current;
    if (!ticket || reported.current) return;
    reported.current = true;

    if (!ticket.ranked) {
      setRecording({ status: "unranked", message: "Sign in to have your matches counted and kept." });
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
        message: outcome.provisional
          ? "Recorded. Attach an account to appear on the leaderboard."
          : "Recorded on the leaderboard.",
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
    restart,
    downloadReplay,
  };
}
