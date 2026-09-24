import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { List } from "@phosphor-icons/react";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { Dialog } from "../components/Dialog";
import { FlightDisplay } from "../components/FlightDisplay";
import { InstantReplay } from "../components/InstantReplay";
import { IntroModal } from "../components/IntroModal";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useCockpitAudio } from "../hooks/useCockpitAudio";
import { useLiveMatch } from "../hooks/useLiveMatch";
import { SCHEMES, introSeen, markIntroSeen, setupFromSearch, toMatchSetup, type Choice } from "../setup";
import type { ControlScheme } from "../input/pilot-input";
import type { DogfightViewer, ViewMode } from "../../viewer";
import type { ReplayFile } from "../../sim/replay";
import { airframe } from "../../sim/airframes";
import { outcomeOf } from "../outcome";

const VIEWS: ReadonlyArray<Choice<ViewMode>> = [
  { value: "chase", label: "Chase" },
  { value: "cockpit", label: "Cockpit" },
  { value: "track", label: "Target track" },
  { value: "arena", label: "Arena" },
  { value: "free", label: "Free look" },
];

const PLAYER = "blue-1";
/** How far back an instant replay starts: enough to see the kill set up. */
const REPLAY_WINDOW_S = 15;

interface Watching {
  file: ReplayFile;
  startAt: number;
  from: "menu" | "results";
}
const ZOOM_PER_WHEEL_PIXEL = 0.0012;

/** Keys the page answers itself, so they are not read while typing into a dialog. */
function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

export function GamePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const setup = useMemo(() => setupFromSearch(location.search), [location.search]);
  const match = useLiveMatch(toMatchSetup(setup));
  const viewer = useRef<DogfightViewer>(undefined);

  const [view, setView] = useState<ViewMode>("chase");
  const [introOpen, setIntroOpen] = useState(() => !introSeen());
  const [menuOpen, setMenuOpen] = useState(false);
  const [watching, setWatching] = useState<Watching>();
  // The menu button is there for a mouse, and out of sight while nobody is moving one.
  const [pointerIdle, setPointerIdle] = useState(true);
  useEffect(() => {
    let timer = 0;
    const moved = () => {
      // A captured mouse is the stick, not a pointer: its movement is flying.
      if (document.pointerLockElement) return;
      setPointerIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setPointerIdle(true), 2_500);
    };
    addEventListener("pointermove", moved);
    return () => {
      removeEventListener("pointermove", moved);
      clearTimeout(timer);
    };
  }, []);
  const finished = match.state?.finished === true;
  const holding = introOpen || menuOpen || watching !== undefined;

  useCockpitAudio(match.liveStateRef, PLAYER, !holding && !finished);

  // A restart unpauses, and one can arrive late (signing in restarts the
  // match), so this re-asserts the pause rather than setting it once.
  const { setPaused, paused } = match;
  useEffect(() => {
    if (paused !== holding) setPaused(holding);
  }, [holding, paused, setPaused]);

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  const pointerFlying = match.scheme === "mouse";
  useEffect(() => {
    viewer.current?.setPointerCaptured(pointerFlying);
  }, [pointerFlying]);

  const resume = useCallback(() => {
    setMenuOpen(false);
    // Space fires the gun; with focus left on a button it would press it too.
    (document.activeElement as HTMLElement | null)?.blur();
    if (match.scheme === "mouse") void match.inputRef.current.requestPointerLock();
  }, [match.scheme, match.inputRef]);

  const closeIntro = useCallback(() => {
    markIntroSeen();
    setIntroOpen(false);
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);

  // Esc opens the menu and V changes the camera. Escape inside an open dialog
  // is the dialog's own, which closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || watching || typingInto(event.target) || document.querySelector("dialog[open]")) return;
      if (event.code === "Escape" || event.code === "KeyP") {
        // Otherwise the browser reads this same Escape as a request to close
        // the dialog it has just opened, and the menu flashes shut.
        event.preventDefault();
        if (!finished) setMenuOpen(true);
      } else if (event.code === "KeyV") {
        setView((current) => VIEWS[(VIEWS.findIndex((entry) => entry.value === current) + 1) % VIEWS.length]!.value);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [finished, watching]);

  // The browser takes Escape for itself to release a captured mouse, so the
  // page never hears it; losing the capture mid-flight is the same request.
  useEffect(() => {
    let wasLocked = false;
    const changed = () => {
      const locked = document.pointerLockElement !== null;
      if (wasLocked && !locked && !finished && !watching && !document.querySelector("dialog[open]")) setMenuOpen(true);
      wasLocked = locked;
    };
    document.addEventListener("pointerlockchange", changed);
    return () => document.removeEventListener("pointerlockchange", changed);
  }, [finished, watching]);

  useEffect(() => {
    if (finished) match.inputRef.current.releasePointerLock();
  }, [finished, match.inputRef]);

  useEffect(() => {
    let frame = 0;
    const orbit = () => {
      const instance = viewer.current;
      if (instance) {
        const delta = match.inputRef.current.consumeViewDelta();
        if (delta.orbitX || delta.orbitY) instance.orbitBy(delta.orbitX, delta.orbitY);
        if (delta.zoom) instance.zoomBy(Math.exp(delta.zoom * ZOOM_PER_WHEEL_PIXEL));
      }
      frame = requestAnimationFrame(orbit);
    };
    frame = requestAnimationFrame(orbit);
    return () => cancelAnimationFrame(frame);
  }, [match.inputRef]);

  const watch = (from: Watching["from"]) => {
    const file = match.replaySoFar();
    if (!file) return;
    const end = file.frames.at(-1)?.t ?? 0;
    match.inputRef.current.releasePointerLock();
    // The live view is taken down while the replay has the screen; a new one
    // announces itself through onReady when play resumes.
    viewer.current = undefined;
    setMenuOpen(false);
    setWatching({ file, startAt: Math.max(0, end - REPLAY_WINDOW_S), from });
  };

  const stopWatching = () => {
    const from = watching?.from;
    setWatching(undefined);
    if (from === "menu") setMenuOpen(true);
  };

  const outcome = finished && match.state ? outcomeOf(match.state, PLAYER) : undefined;
  const jets = match.state?.aircraft.map((aircraft) => airframe(aircraft.airframe).name) ?? [];
  const matchup = jets.length === 2 ? `${jets[0]} vs ${jets[1]}` : "";
  const viewLabel = VIEWS.find((entry) => entry.value === view)?.label ?? "";

  if (watching) {
    return (
      <div className="game">
        <InstantReplay
          replay={watching.file}
          startAt={watching.startAt}
          views={VIEWS}
          initialView={view}
          onExit={stopWatching}
          exitLabel={watching.from === "menu" ? "Back to menu" : "Done"}
        />
      </div>
    );
  }

  return (
    <div className="game">
      <ViewerCanvas
        snapshotRef={match.snapshotRef}
        followId={PLAYER}
        onReady={(instance) => {
          viewer.current = instance;
          instance.setView(view);
          instance.setPointerCaptured(pointerFlying);
        }}
      />
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={PLAYER} detailsOpen={false} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={PLAYER} />

      <button
        className={`hud-menu${pointerIdle ? " idle" : ""}`}
        onClick={() => setMenuOpen(true)}
        aria-label="Pause menu (Esc)"
        title="Menu (Esc)"
      >
        <List aria-hidden />
      </button>

      <div key={view} className="view-toast" role="status">
        {viewLabel}
      </div>

      {pointerFlying && match.canCapturePointer && !holding && !finished ? (
        <button className="capture-hint" onClick={() => void match.inputRef.current.requestPointerLock()}>
          Click to fly with the mouse
        </button>
      ) : null}

      <IntroModal open={introOpen} scheme={match.scheme} weapons={setup.weapons} onClose={closeIntro} />

      <Dialog open={menuOpen} onClose={resume} title="Paused" className="menu">
        <div className="menu-primary">
          <button className="primary large" onClick={resume} autoFocus>
            Resume
          </button>
          <button
            className="large"
            onClick={() => {
              match.restart();
              resume();
            }}
          >
            Restart
          </button>
        </div>

        <ChoiceGroup
          legend="Controls"
          name="controls"
          choices={SCHEMES}
          value={match.scheme}
          onChange={(scheme: ControlScheme) => match.setScheme(scheme)}
        />

        <div className="menu-secondary">
          <button className="quiet" onClick={() => watch("menu")} disabled={(match.state?.time ?? 0) < 1}>
            Instant replay
          </button>
          <button className="quiet" onClick={() => { setMenuOpen(false); setIntroOpen(true); }}>
            How to play
          </button>
          <button className="quiet" onClick={() => navigate("/")}>
            Quit
          </button>
        </div>
      </Dialog>

      <Dialog
        open={outcome !== undefined}
        onClose={() => navigate("/")}
        title={outcome?.headline ?? ""}
        description={outcome?.reason}
        className={`results results-${outcome?.verdict ?? "draw"}`}
        dismissible={false}
      >
        <p className="results-matchup">{matchup}</p>
        <dl className="results-stats">
          {outcome?.stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions">
          <button className="primary large" onClick={match.restart} autoFocus>
            Fly again
          </button>
          <button className="large" onClick={() => watch("results")}>
            Watch replay
          </button>
          <button className="quiet" onClick={() => navigate("/")}>
            Menu
          </button>
        </div>
      </Dialog>
    </div>
  );
}
