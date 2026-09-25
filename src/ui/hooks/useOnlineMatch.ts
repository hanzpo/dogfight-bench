import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { OnlineClient, type LobbyMessage } from "../../net/client";
import type { Seat } from "../../net/protocol";
import type { AirframeId } from "../../sim/airframes";
import type { Loadout, MatchState } from "../../sim/types";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";
import { PilotInput, loadSettings, type ControlScheme, type MouseMode } from "../input/pilot-input";
import { tabSession } from "../session";

const UI_REFRESH_MS = 100;

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Close codes the room uses for "not you": a full or started room, and a newer connection from the same tab. */
const ROOM_UNAVAILABLE = 4000;
const REPLACED = 4001;
/** Tries to get back after a drop, spread over about the twenty seconds the room holds a seat. */
const MAX_RECONNECTS = 6;

export interface OnlineMatch {
  snapshotRef: RefObject<ViewerSnapshot | undefined>;
  liveStateRef: RefObject<MatchState | undefined>;
  /** The match as drawn, refreshed for the page a few times a second. */
  state: MatchState | undefined;
  lobby: LobbyMessage | undefined;
  seat: Seat | undefined;
  status: ConnectionStatus;
  error: string | undefined;
  pingMs: number | undefined;
  inputRef: RefObject<PilotInput>;
  scheme: ControlScheme;
  canCapturePointer: boolean;
  mouseMode: MouseMode;
  setScheme: (scheme: ControlScheme) => void;
  setReady: (ready: boolean) => void;
  setWeapons: (weapons: Loadout) => void;
  chooseAircraft: (airframe: AirframeId) => void;
}

export interface OnlineSetup {
  code: string;
  quick: boolean;
  name: string;
  aircraft: AirframeId;
  scheme: ControlScheme;
}

function socketUrl({ code, quick, name, aircraft }: OnlineSetup): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const query = new URLSearchParams({ name, airframe: aircraft, session: tabSession(), ...(quick ? { quick: "1" } : {}) });
  return `${protocol}://${location.host}/api/online/rooms/${encodeURIComponent(code)}/socket?${query}`;
}

/**
 * An online match from this player's seat: the connection to the room, the
 * prediction that keeps the jet answering the stick, and what the viewer and
 * the HUD read, in the same shape the offline game gives them.
 */
export function useOnlineMatch(setup: OnlineSetup): OnlineMatch {
  const input = useRef<PilotInput>(undefined as unknown as PilotInput);
  if (!input.current) {
    input.current = new PilotInput();
    input.current.settings = loadSettings();
  }
  const client = useRef<OnlineClient>(undefined);
  const socket = useRef<WebSocket>(undefined);
  const snapshotRef = useRef<ViewerSnapshot>(undefined);
  const liveStateRef = useRef<MatchState>(undefined);
  const effectsFrom = useRef(0);
  const startedScenario = useRef<unknown>(undefined);

  const [state, setState] = useState<MatchState>();
  const [lobby, setLobby] = useState<LobbyMessage>();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string>();
  const [pingMs, setPingMs] = useState<number>();
  const [scheme, setSchemeState] = useState<ControlScheme>(() => {
    input.current.scheme = setup.scheme;
    return setup.scheme;
  });
  const [canCapturePointer, setCanCapturePointer] = useState(false);
  const [mouseMode, setMouseMode] = useState<MouseMode>("absolute");

  // One connection per room; the name and jet it opens with are only its first word.
  const opening = useRef(setup);
  opening.current = setup;
  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let done = false;
    const online = new OnlineClient((message) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    });
    client.current = online;
    setError(undefined);

    const connect = () => {
      const opened = new WebSocket(socketUrl(opening.current));
      ws = opened;
      socket.current = opened;
      setStatus(attempts ? "reconnecting" : "connecting");
      opened.addEventListener("open", () => {
        attempts = 0;
        setStatus("open");
      });
      opened.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        online.receive(message, performance.now());
        if (message.type === "lobby") setLobby(message);
        if (message.type === "error") setError(message.message);
      });
      opened.addEventListener("close", (event) => {
        if (done || opened !== ws) return;
        // Turned away, or the seat taken over by this tab's newer connection: nothing to come back to.
        if (event.code === ROOM_UNAVAILABLE || event.code === REPLACED || attempts >= MAX_RECONNECTS) {
          setStatus("closed");
          return;
        }
        // Anything else is a drop the room holds the seat through; come back to it.
        attempts += 1;
        setStatus("reconnecting");
        retry = setTimeout(connect, Math.min(8_000, 500 * 2 ** attempts));
      });
    };
    connect();
    // On a timer as well as every frame: a hidden tab draws no frames but must still be heard from.
    const heartbeat = setInterval(() => online.heartbeat(performance.now()), 1_000);
    return () => {
      done = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      // Leaving the page within the site is giving up the seat; a reload never gets here and keeps it.
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "leave" }));
      ws?.close();
      socket.current = undefined;
      client.current = undefined;
    };
  }, [setup.code, setup.quick]);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>("#viewport") ?? document.body;
    const detach = input.current.attach(host);
    const poll = setInterval(() => {
      setCanCapturePointer(input.current.canCapturePointer);
      setMouseMode(input.current.mouseMode);
      const online = client.current;
      if (online && online.rttMs) setPingMs(Math.round(online.rttMs));
    }, 250);
    return () => {
      detach();
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let lastUi = 0;
    const tick = (now: number) => {
      const wallDt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const online = client.current;
      if (online) {
        const flying = online.lobby?.phase === "flying" && !online.finished;
        online.frame(now, input.current.sample(flying ? wallDt : 0));
        if (online.scenario !== startedScenario.current) {
          startedScenario.current = online.scenario;
          effectsFrom.current = 0;
          input.current.reset();
        }
        const shown = online.displayState();
        if (shown) {
          // Sparks and bursts only once the room has said they happened.
          snapshotRef.current = snapshotFromMatch(shown, effectsFrom.current, online.events);
          effectsFrom.current = online.events.length;
          liveStateRef.current = shown;
          if (now - lastUi >= UI_REFRESH_MS) {
            lastUi = now;
            setState({ ...shown, finished: online.finished, winnerId: online.latest?.winnerId, finishReason: online.latest?.finishReason });
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const send = useCallback((message: Parameters<OnlineClient["choose"]>[0]) => client.current?.choose(message), []);

  const setScheme = useCallback((next: ControlScheme) => {
    input.current.scheme = next;
    input.current.reset();
    if (next !== "mouse") input.current.releasePointerLock();
    setSchemeState(next);
    setCanCapturePointer(input.current.canCapturePointer);
    setMouseMode(input.current.mouseMode);
  }, []);

  return {
    snapshotRef,
    liveStateRef,
    state,
    lobby,
    seat: lobby?.you,
    status,
    error,
    pingMs,
    inputRef: input,
    scheme,
    canCapturePointer,
    mouseMode,
    setScheme,
    setReady: useCallback((ready: boolean) => send({ type: "ready", ready }), [send]),
    setWeapons: useCallback((weapons: Loadout) => send({ type: "weapons", weapons }), [send]),
    chooseAircraft: useCallback((airframe: AirframeId) => send({ type: "choose", airframe }), [send]),
  };
}
