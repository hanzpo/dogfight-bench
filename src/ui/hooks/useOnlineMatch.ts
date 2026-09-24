import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { OnlineClient, type LobbyMessage } from "../../net/client";
import type { Seat } from "../../net/protocol";
import type { AirframeId } from "../../sim/airframes";
import type { Loadout, MatchState } from "../../sim/types";
import { snapshotFromMatch, type ViewerSnapshot } from "../../viewer";
import { PilotInput, loadSettings, type ControlScheme, type MouseMode } from "../input/pilot-input";

const UI_REFRESH_MS = 100;

export type ConnectionStatus = "connecting" | "open" | "closed";

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
  rename: (name: string, airframe: AirframeId) => void;
}

export interface OnlineSetup {
  code: string;
  quick: boolean;
  name: string;
  aircraft: AirframeId;
  scheme: ControlScheme;
}

/** This tab, to the room: a connection from it again takes its seat back rather than a new one. */
function tabSession(): string {
  try {
    const stored = sessionStorage.getItem("dogfight.session");
    if (stored) return stored;
    const made = crypto.randomUUID();
    sessionStorage.setItem("dogfight.session", made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
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
    const ws = new WebSocket(socketUrl(opening.current));
    socket.current = ws;
    const online = new OnlineClient((message) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    });
    client.current = online;
    setStatus("connecting");
    setError(undefined);
    ws.addEventListener("open", () => setStatus("open"));
    ws.addEventListener("message", (event) => {
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
    ws.addEventListener("close", () => setStatus("closed"));
    return () => {
      ws.close();
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
    rename: useCallback((name: string, airframe: AirframeId) => send({ type: "hello", name, airframe }), [send]),
  };
}
