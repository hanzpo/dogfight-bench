import { useEffect, useMemo, useRef, useState } from "react";
import { FlightDisplay } from "../components/FlightDisplay";
import { ObserverPanel } from "../components/ObserverPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { ModelKeysPanel } from "../components/ModelKeysPanel";
import { useLiveMatch, type PilotChoice } from "../hooks/useLiveMatch";
import { useRoster } from "../hooks/useRoster";
import { loadKey } from "../keys";
import { CONTROL_SCHEMES, type ControlScheme } from "../input/pilot-input";
import type { DogfightViewer, ViewMode } from "../../viewer";

/** What to tell the pilot, for whatever they are holding. */
const KEYMAP: Record<ControlScheme, string> = {
  keyboard: "W PUSH · S PULL · A/D ROLL · Q/E RUDDER · R/F THROTTLE · SPACE FIRE",
  mouse: "MOUSE STICK · LEFT FIRE · RIGHT-DRAG LOOK · WHEEL ZOOM · Q/E RUDDER · R/F THROTTLE",
  gamepad: "RIGHT STICK · LEFT STICK RUDDER · TRIGGERS THROTTLE · RB FIRE",
};

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
  const roster = useRoster();
  const viewer = useRef<DogfightViewer>(undefined);
  const [view, setView] = useState<ViewMode>("orbit");
  /**
   * The observer panel is 286 wide and would cover most of a phone, so it
   * starts as a tab there. Measured once, not tracked: somebody who opens it
   * deliberately should not have it shut again by a rotation.
   */
  const [observerOpen, setObserverOpen] = useState(() => globalThis.innerWidth > 900);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keyNonce, setKeyNonce] = useState(0);
  const followId = match.followRed ? "red-1" : "blue-1";

  /**
   * Which opponents can actually be flown right now.
   *
   * A model is flyable if this deployment offers it free and the day's
   * allowance is not spent, or if a key for it has been entered here. Anything
   * else is offered but labelled, so the reason it will not fly is on the
   * control rather than in a failed request thirty seconds into a match.
   */
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
        const note = hasKey ? "your key" : free ? "free" : budget?.exhausted ? "allowance spent" : "needs a key";
        return { value: agent.kind, label: agent.name, note, usable: free || hasKey };
      });
    return { scripted, models };
  }, [roster.agents, roster.freeBudget, keyNonce]);

  const lastDecision = match.decisions[followId];
  const decisionError = lastDecision?.error;

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  // While the pointer belongs to the aircraft, it must not also orbit the
  // camera.
  const pointerFlying = match.scheme === "mouse";
  useEffect(() => {
    viewer.current?.setPointerCaptured(pointerFlying);
  }, [pointerFlying]);

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
      if (instance) {
        // Camera movement the pilot asked for with the right button and wheel,
        // applied once per frame rather than once per mouse event.
        const view = match.inputRef.current.consumeViewDelta();
        if (view.orbitX || view.orbitY) instance.orbitBy(view.orbitX, view.orbitY);
        if (view.zoom) instance.zoomBy(Math.exp(view.zoom * 0.0012));
      }
      if (app && instance) {
        app.dataset["simTime"] = (match.simTimeRef.current ?? 0).toFixed(3);
        const stats = instance.stats;
        app.dataset["frameMs"] = stats.frameTimeMs.toFixed(2);
        app.dataset["renderScale"] = stats.renderScale.toFixed(2);
        app.dataset["drawCalls"] = String(stats.drawCalls);
        app.dataset["triangles"] = String(stats.triangles);
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
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} observerOpen={observerOpen} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={followId} />
      {view === "orbit" && !pointerFlying ? (
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
      <ObserverPanel
        state={match.state}
        followId={followId}
        decision={lastDecision}
        open={observerOpen}
        onToggle={() => setObserverOpen(!observerOpen)}
      />

      {/* Three groups, because they answer three different questions: who is
          flying, how you are watching, and what to do now. Wrapped together as
          one row they read as a pile of controls. */}
      <footer className="controls">
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
                {option.label} · {option.note}
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
                {option.label} · {option.note}
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
            <option value="orbit">External</option>
            <option value="cockpit">Cockpit</option>
          </select>
        </label>
        <button id="follow" onClick={() => match.setFollowRed(!match.followRed)}>
          {match.followRed ? "Follow blue" : "Follow red"}
        </button>
        <button id="pause" onClick={() => match.setPaused(!match.paused)}>
          {match.paused ? "Resume" : "Pause"}
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
        <button id="restart" onClick={match.restart}>
          Restart
        </button>
        <button id="replay" onClick={match.downloadReplay}>
          Save replay
        </button>
        <button id="model-keys" onClick={() => setKeysOpen(true)}>
          Model keys
        </button>
        </div>
      </footer>

      <div className="flight-strip">
        <span id="flight-data">
          {followed
            ? `${followId.toUpperCase()} · ${Math.round(followed.velocity.length() * 1.94384)} KT · ${followed.ammo} ROUNDS`
            : "STANDING BY"}
        </span>
        <span className="keymap">{KEYMAP[match.scheme]}</span>
        <span id="event">{event}</span>
      </div>

      {match.recording.status !== "idle" ? (
        <div className={`recording recording-${match.recording.status}`} role="status">
          <span className="recording-dot" />
          <span>
            {match.recording.status === "ranked"
              ? "Ranked match — the result will count"
              : match.recording.status === "saving"
                ? "Saving result…"
                : (match.recording.message ?? "Not recorded")}
          </span>
        </div>
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
