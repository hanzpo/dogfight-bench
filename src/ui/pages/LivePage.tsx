import { useEffect, useMemo, useRef, useState } from "react";
import { FlightDisplay } from "../components/FlightDisplay";
import { ObserverPanel } from "../components/ObserverPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useLiveMatch, type PilotKind } from "../hooks/useLiveMatch";
import type { DogfightViewer, ViewMode } from "../../viewer";

/**
 * The live match page.
 *
 * The control ids, their visible labels and the `#app` dataset below are part
 * of the contract with the Jev browser-feedback harness in `tools/` and the
 * Playwright check in `tools/ui-check`, both of which drive these controls and
 * then verify the resulting state independently. Renaming them silently breaks
 * those tests, so they are deliberate.
 */
export function LivePage() {
  const match = useLiveMatch();
  const viewer = useRef<DogfightViewer>(undefined);
  const [view, setView] = useState<ViewMode>("orbit");
  const [observerOpen, setObserverOpen] = useState(true);
  const followId = match.followRed ? "red-1" : "blue-1";

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  // Derived during render. Setting this from an effect keyed on an object that
  // is rebuilt every frame is what drove React past its update depth.
  const event = useMemo(() => {
    if (!match.state) return "MERGE INITIALIZED";
    if (match.state.finished) {
      return `${match.state.winnerId?.toUpperCase() ?? "DRAW"} · ${match.state.finishReason}`;
    }
    const latest = match.state.events.at(-1);
    return latest ? `${latest.type.toUpperCase()} ${latest.actorId ?? ""}` : "MERGE INITIALIZED";
  }, [match.state]);

  // UI state the harness reads, published whenever it changes.
  useEffect(() => {
    const app = document.querySelector<HTMLElement>("#app");
    if (!app) return;
    app.dataset["simStatus"] = match.state?.finished ? "complete" : match.paused ? "paused" : "running";
    app.dataset["follow"] = followId;
    app.dataset["timeScale"] = String(match.timeScale);
    app.dataset["bluePilot"] = match.bluePilot;
    app.dataset["view"] = view;
  }, [match.state?.finished, match.paused, match.timeScale, match.bluePilot, followId, view]);

  /**
   * Camera and framing are published from their own frame loop rather than from
   * React state. They change every frame, and the whole point of measuring them
   * is to catch drift that only shows up between frames.
   */
  useEffect(() => {
    let frame = 0;
    const publish = () => {
      const app = document.querySelector<HTMLElement>("#app");
      const instance = viewer.current;
      if (app && instance) {
        app.dataset["simTime"] = (match.simTimeRef.current ?? 0).toFixed(3);
        app.dataset["camera"] = instance.camera.position
          .toArray()
          .map((value) => value.toFixed(3))
          .join(",");
        const framing = instance.getFollowFraming();
        if (framing) {
          app.dataset["subjectScreenX"] = framing.x.toFixed(4);
          app.dataset["subjectScreenY"] = framing.y.toFixed(4);
          app.dataset["subjectMinX"] = framing.minX.toFixed(4);
          app.dataset["subjectMaxX"] = framing.maxX.toFixed(4);
          app.dataset["subjectMinY"] = framing.minY.toFixed(4);
          app.dataset["subjectMaxY"] = framing.maxY.toFixed(4);
        }
      }
      frame = requestAnimationFrame(publish);
    };
    frame = requestAnimationFrame(publish);
    return () => cancelAnimationFrame(frame);
  }, [match.simTimeRef]);

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
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} observerOpen={observerOpen} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} />
      {view === "orbit" ? <div className="orbit-help">DRAG TO ORBIT · SCROLL TO ZOOM</div> : null}
      <ObserverPanel state={match.state} followId={followId} open={observerOpen} onToggle={() => setObserverOpen(!observerOpen)} />

      <footer className="controls">
        <label>
          BLUE PILOT
          <select
            id="blue-pilot"
            value={match.bluePilot}
            onChange={(changed) => match.setBluePilot(changed.target.value as PilotKind)}
          >
            <option value="human">HUMAN</option>
            <option value="basic">BASELINE AI</option>
            <option value="model">SERVER MODEL</option>
          </select>
        </label>
        <label>
          VIEW
          <select id="view" value={view} onChange={(changed) => setView(changed.target.value as ViewMode)}>
            <option value="orbit">EXTERNAL</option>
            <option value="cockpit">COCKPIT</option>
          </select>
        </label>
        <button id="follow" onClick={() => match.setFollowRed(!match.followRed)}>
          {match.followRed ? "FOLLOW BLUE" : "FOLLOW RED"}
        </button>
        <button id="pause" onClick={() => match.setPaused(!match.paused)}>
          {match.paused ? "RESUME" : "PAUSE"}
        </button>
        <label>
          SPEED
          <select
            id="speed"
            value={match.timeScale}
            onChange={(changed) => match.setTimeScale(Number(changed.target.value))}
          >
            <option value="1">1× REALTIME</option>
            <option value="4">4× ACCELERATED</option>
            <option value="16">16× ACCELERATED</option>
          </select>
        </label>
        <button id="restart" onClick={match.restart}>
          RESTART MATCH
        </button>
        <button id="replay" onClick={match.downloadReplay}>
          SAVE REPLAY
        </button>
      </footer>

      <div className="flight-strip">
        <span id="flight-data">
          {followed
            ? `${followId.toUpperCase()} · ${Math.round(followed.velocity.length() * 1.94384)} KT · ${followed.ammo} ROUNDS`
            : "STANDING BY"}
        </span>
        <span id="event">{event}</span>
      </div>
      <div className="keymap">W PUSH · S PULL · A/D ROLL · Q/E RUDDER · R/F THROTTLE · SPACE FIRE</div>
    </>
  );
}
