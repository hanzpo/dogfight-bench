import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  DownloadSimple,
  Gear,
  Pause,
  Play,
} from "@phosphor-icons/react";
import { FlightDisplay } from "../components/FlightDisplay";
import { DetailsPanel } from "../components/DetailsPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { OPEN_ACCOUNT_MENU } from "../components/AccountMenu";
import { ModelKeysPanel } from "../components/ModelKeysPanel";
import { useLiveMatch, type PilotChoice } from "../hooks/useLiveMatch";
import { useRoster } from "../hooks/useRoster";
import { loadKey } from "../keys";
import { CONTROL_SCHEMES, type ControlScheme } from "../input/pilot-input";
import type { DogfightViewer, ViewMode } from "../../viewer";

function pilotNote(hasKey: boolean, free: boolean, exhausted: boolean): string {
  if (hasKey) return "your key";
  if (free) return "free";
  if (exhausted) return "allowance spent";
  return "needs a key";
}

const ZOOM_PER_WHEEL_PIXEL = 0.0012;

/**
 * Everything the browser check measures, written onto `#app` as data attributes.
 *
 * Positions and sizes a person can see, rather than anything the viewer exports
 * for testing, so a check that passes is a check on what was drawn.
 */
function publishDiagnostics(viewer: DogfightViewer, simTimeS: number): void {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) return;
  const stats = viewer.stats;
  const framing = viewer.getFollowFraming();
  const data: Record<string, string> = {
    simTime: simTimeS.toFixed(3),
    frameMs: stats.frameTimeMs.toFixed(2),
    renderScale: stats.renderScale.toFixed(2),
    drawCalls: String(stats.drawCalls),
    triangles: String(stats.triangles),
    camera: viewer.camera.position.toArray().map((value) => value.toFixed(3)).join(","),
    ...(framing
      ? {
          subjectScreenX: framing.x.toFixed(4),
          subjectScreenY: framing.y.toFixed(4),
          subjectMinX: framing.minX.toFixed(4),
          subjectMaxX: framing.maxX.toFixed(4),
          subjectMinY: framing.minY.toFixed(4),
          subjectMaxY: framing.maxY.toFixed(4),
          subjectDistance: framing.distanceM.toFixed(1),
        }
      : {}),
  };
  for (const [key, value] of Object.entries(data)) app.dataset[key] = value;
}

const KEYMAP: Record<ControlScheme, string> = {
  keyboard: "W PUSH · S PULL · A/D ROLL · Q/E RUDDER · R/F THROTTLE · SPACE FIRE",
  mouse: "MOUSE STICK · LEFT FIRE · RIGHT-DRAG LOOK · WHEEL ZOOM · Q/E RUDDER · R/F THROTTLE",
  gamepad: "RIGHT STICK · LEFT STICK RUDDER · TRIGGERS THROTTLE · RB FIRE",
};

export function LivePage() {
  const match = useLiveMatch();
  const roster = useRoster();
  const viewer = useRef<DogfightViewer>(undefined);
  const [view, setView] = useState<ViewMode>("chase");
  const [detailsOpen, setDetailsOpen] = useState(() => globalThis.innerWidth > 900);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keyNonce, setKeyNonce] = useState(0);
  const followId = match.followRed ? "red-1" : "blue-1";

  const pilotOptions = useMemo(() => {
    void keyNonce;
    const scripted = [
      { value: "basic", label: "Baseline · energy fighter", note: "" },
      { value: "basic-pursuit", label: "Baseline · naive pursuit", note: "" },
    ];
    const models = roster.agents
      .filter((agent) => agent.provider !== "scripted")
      .map((agent) => {
        const budget = roster.freeBudget.find((entry) => entry.provider === agent.kind);
        const hasKey = Boolean(loadKey(agent.kind));
        const free = agent.free && agent.available && !budget?.exhausted;
        const note = pilotNote(hasKey, free, Boolean(budget?.exhausted));
        const interfaceName = agent.schema === "raw" ? "stick" : "manoeuvres";
        return { value: agent.kind, label: agent.name, interfaceName, note, usable: free || hasKey };
      });
    return { scripted, models };
  }, [roster.agents, roster.freeBudget, keyNonce]);

  const lastDecision = match.decisions[followId];
  const decisionError = lastDecision?.error;

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  const pointerFlying = match.scheme === "mouse";
  useEffect(() => {
    viewer.current?.setPointerCaptured(pointerFlying);
  }, [pointerFlying]);

  const event = useMemo(() => {
    if (!match.state) return "MERGE INITIALIZED";
    if (match.state.finished) {
      return `${match.state.winnerId?.toUpperCase() ?? "DRAW"} · ${match.state.finishReason}`;
    }
    const latest = match.state.events.at(-1);
    return latest ? `${latest.type.toUpperCase()} ${latest.actorId ?? ""}` : "MERGE INITIALIZED";
  }, [match.state]);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>("#app");
    if (!app) return;
    app.dataset["simStatus"] = match.state?.finished ? "complete" : match.paused ? "paused" : "running";
    app.dataset["follow"] = followId;
    app.dataset["timeScale"] = String(match.timeScale);
    app.dataset["bluePilot"] = match.bluePilot;
    app.dataset["view"] = view;
  }, [match.state?.finished, match.paused, match.timeScale, match.bluePilot, followId, view]);

  useEffect(() => {
    let frame = 0;
    const publish = () => {
      const instance = viewer.current;
      if (instance) {
        const delta = match.inputRef.current.consumeViewDelta();
        if (delta.orbitX || delta.orbitY) instance.orbitBy(delta.orbitX, delta.orbitY);
        if (delta.zoom) instance.zoomBy(Math.exp(delta.zoom * ZOOM_PER_WHEEL_PIXEL));
        publishDiagnostics(instance, match.simTimeRef.current ?? 0);
      }
      frame = requestAnimationFrame(publish);
    };
    frame = requestAnimationFrame(publish);
    return () => cancelAnimationFrame(frame);
  }, [match.simTimeRef, match.inputRef]);

  const followed = match.state?.aircraft.find((aircraft) => aircraft.id === followId);

  return (
    <>
      <ViewerCanvas
        snapshotRef={match.snapshotRef}
        followId={followId}
        onReady={(instance) => {
          viewer.current = instance;
          instance.setView(view);
        }}
      />
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} detailsOpen={detailsOpen} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} />
      {view === "free" && !pointerFlying ? (
        <div className="orbit-help">DRAG TO ORBIT · SCROLL TO ZOOM</div>
      ) : null}

      {match.bluePilot === "human" && match.scheme === "mouse" ? (
        <div className="pointer-hint">
          {match.canCapturePointer ? (
            <button id="capture-pointer" onClick={() => void match.inputRef.current.requestPointerLock()}>
              Capture pointer
            </button>
          ) : null}
          <span>
            {match.mouseMode === "relative"
              ? "MOVEMENT IS THE STICK · LEFT FIRE · RIGHT-DRAG LOOK · MIDDLE CENTRE · ESC RELEASES"
              : "CURSOR OFFSET IS THE STICK · LEFT FIRE · RIGHT-DRAG LOOK · WHEEL ZOOM"}
          </span>
        </div>
      ) : null}
      <DetailsPanel
        state={match.state}
        followId={followId}
        decision={lastDecision}
        open={detailsOpen}
        onToggle={() => setDetailsOpen(!detailsOpen)}
      />

      <footer className="controls">
        <div className="keymap">{KEYMAP[match.scheme]}</div>
        <div className="control-rows">
        <div className="control-group">
        <label>
          You
          <select
            id="blue-pilot"
            value={match.bluePilot}
            onChange={(changed) => match.setBluePilot(changed.target.value as PilotChoice)}
          >
            <option value="human">Human — you fly</option>
            {pilotOptions.scripted.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {pilotOptions.models.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.interfaceName} · {option.note}
              </option>
            ))}
          </select>
        </label>
        <label>
          Opponent
          <select
            id="red-pilot"
            value={match.redPilot}
            onChange={(changed) => match.setRedPilot(changed.target.value as PilotChoice)}
          >
            {pilotOptions.scripted.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            {pilotOptions.models.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.interfaceName} · {option.note}
              </option>
            ))}
          </select>
        </label>
        </div>

        <div className="control-group">
        <label>
          Controls
          <select
            id="control-scheme"
            value={match.scheme}
            onChange={(changed) => match.setScheme(changed.target.value as ControlScheme)}
          >
            {CONTROL_SCHEMES.map((option) => (
              <option key={option} value={option}>
                {option[0]!.toUpperCase() + option.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          View
          <select id="view" value={view} onChange={(changed) => setView(changed.target.value as ViewMode)}>
            <option value="chase">Chase</option>
            <option value="track">Target track</option>
            <option value="arena">Arena</option>
            <option value="cockpit">Cockpit</option>
            <option value="free">Free look</option>
          </select>
        </label>
        <label>
          Camera
          <div className="segmented" role="group" aria-label="Which aircraft the camera follows">
            <button
              id="follow-blue"
              aria-pressed={!match.followRed}
              onClick={() => match.setFollowRed(false)}
            >
              Blue
            </button>
            <button
              id="follow"
              aria-pressed={match.followRed}
              onClick={() => match.setFollowRed(true)}
            >
              Red
            </button>
          </div>
        </label>
        <button
          id="pause"
          className="icon"
          aria-label={match.paused ? "Resume" : "Pause"}
          title={match.paused ? "Resume" : "Pause"}
          onClick={() => match.setPaused(!match.paused)}
        >
          {match.paused ? <Play weight="fill" /> : <Pause weight="fill" />}
        </button>
        <label>
          Speed
          <select
            id="speed"
            value={match.timeScale}
            onChange={(changed) => match.setTimeScale(Number(changed.target.value))}
          >
            <option value="1">1× real time</option>
            <option value="4">4×</option>
            <option value="16">16×</option>
          </select>
        </label>
        </div>

        <div className="control-group">
        <button id="restart" className="icon" aria-label="Restart match" title="Restart match" onClick={match.restart}>
          <ArrowCounterClockwise />
        </button>
        <button
          id="replay"
          className="icon"
          aria-label="Save replay"
          title="Save replay"
          onClick={match.downloadReplay}
        >
          <DownloadSimple />
        </button>
        <button
          id="model-keys"
          className="icon"
          aria-label="Model keys"
          title="Model keys"
          onClick={() => setKeysOpen(true)}
        >
          <Gear />
        </button>
        </div>
        </div>
      </footer>

      <div className="flight-strip">
        <span id="flight-data">{followed ? followId.toUpperCase() : "STANDING BY"}</span>
        <span id="event">{event}</span>
      </div>

      {match.recording.status !== "idle" ? (
        (() => {
          const label =
            match.recording.status === "ranked"
              ? "Ranked"
              : match.recording.status === "saving"
                ? "Saving…"
                : (match.recording.message ?? "Not recorded");
          const opensSignIn = label.includes("sign in");
          const body = (
            <>
              <span className="recording-dot" />
              <span>{label}</span>
            </>
          );
          return opensSignIn ? (
            <button
              className={`recording recording-${match.recording.status}`}
              onClick={() => dispatchEvent(new Event(OPEN_ACCOUNT_MENU))}
            >
              {body}
            </button>
          ) : (
            <div className={`recording recording-${match.recording.status}`} role="status">
              {body}
            </div>
          );
        })()
      ) : null}

      {decisionError ? (
        <div className="decision-error" role="status">
          <strong>{followId.toUpperCase()}</strong>
          <span>{decisionError}</span>
          {/^.*(key|allowance).*$/i.test(decisionError) ? (
            <button className="ghost" onClick={() => setKeysOpen(true)}>
              Add a key
            </button>
          ) : null}
        </div>
      ) : null}

      {keysOpen ? (
        <ModelKeysPanel
          agents={roster.agents}
          onClose={() => setKeysOpen(false)}
          onChanged={() => setKeyNonce((value) => value + 1)}
        />
      ) : null}
    </>
  );
}
