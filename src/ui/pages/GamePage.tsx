import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { List } from "@phosphor-icons/react";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { DetailsPanel } from "../components/DetailsPanel";
import { Dialog } from "../components/Dialog";
import { FlightDisplay } from "../components/FlightDisplay";
import { IntroModal } from "../components/IntroModal";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useCockpitAudio } from "../hooks/useCockpitAudio";
import { useLiveMatch } from "../hooks/useLiveMatch";
import { OPPONENTS, SCHEMES, introSeen, markIntroSeen, setupFromSearch, toMatchSetup, type Choice } from "../setup";
import type { ControlScheme } from "../input/pilot-input";
import type { DogfightViewer, ViewMode } from "../../viewer";
import type { MatchState } from "../../sim/types";

const VIEWS: ReadonlyArray<Choice<ViewMode>> = [
  { value: "chase", label: "Chase", detail: "" },
  { value: "cockpit", label: "Cockpit", detail: "" },
  { value: "track", label: "Target track", detail: "" },
  { value: "arena", label: "Arena", detail: "" },
  { value: "free", label: "Free look", detail: "" },
];

const PLAYER = "blue-1";
const ZOOM_PER_WHEEL_PIXEL = 0.0012;

/** Keys the page answers itself, so they are not read while typing into a dialog. */
function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

interface Outcome {
  verdict: "won" | "lost" | "draw";
  headline: string;
  reason: string;
  stats: Array<{ label: string; value: string }>;
}

/** Why an aircraft went down, said to the person flying the blue one. */
function howItEnded(reason: string | undefined, you: boolean): { headline?: string; line: string } {
  const who = you ? "You" : "The bandit";
  switch (reason) {
    case "terrain impact":
      return { headline: you ? "Crashed" : undefined, line: `${who} flew into the ground.` };
    case "hard deck violation":
      return { headline: you ? "Too low" : undefined, line: `${who} stayed below the hard deck too long.` };
    case "left the arena":
      return { headline: you ? "Out of bounds" : undefined, line: `${who} left the arena.` };
    case "AIM-9M":
      return { line: you ? "A Sidewinder got you." : "Your Sidewinder found it." };
    case "pilot incapacitated":
      return { line: you ? "A hit in the cockpit ended it." : "A hit in the cockpit ended it for the bandit." };
    default:
      return { line: you ? "Their guns took you apart." : "Your guns took it apart." };
  }
}

function outcomeOf(state: MatchState): Outcome {
  const you = state.aircraft.find((aircraft) => aircraft.id === PLAYER);
  const bandit = state.aircraft.find((aircraft) => aircraft.id !== PLAYER);
  const won = state.winnerId === PLAYER;
  const verdict = state.winnerId === undefined ? "draw" : won ? "won" : "lost";
  const count = (type: string, actor: string) =>
    state.events.filter((event) => event.type === type && event.actorId === actor).length;
  const minutes = Math.floor(state.time / 60);
  const seconds = Math.floor(state.time % 60);

  let headline = verdict === "won" ? "Splash one" : verdict === "lost" ? "Shot down" : "Draw";
  let reason: string;
  if (state.finishReason === "mutual destruction") {
    reason = "You took each other down.";
  } else if (state.finishReason?.startsWith("time limit")) {
    reason = verdict === "draw" ? "Time ran out, level on points." : `Time ran out; ${won ? "you" : "the bandit"} won on points.`;
  } else if (verdict === "lost") {
    const ended = howItEnded(you?.destroyedReason, true);
    headline = ended.headline ?? headline;
    reason = ended.line;
  } else if (verdict === "won") {
    reason = howItEnded(bandit?.destroyedReason, false).line;
  } else {
    reason = state.finishReason ?? "";
  }

  return {
    verdict,
    headline,
    reason,
    stats: [
      { label: "Time", value: `${minutes}:${String(seconds).padStart(2, "0")}` },
      { label: "Hits scored", value: String(count("hit", PLAYER)) },
      { label: "Hits taken", value: String(bandit ? count("hit", bandit.id) : 0) },
      { label: "Missiles fired", value: String(count("missile-launch", PLAYER)) },
    ],
  };
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
  const [telemetry, setTelemetry] = useState(false);
  const finished = match.state?.finished === true;
  const holding = introOpen || menuOpen;

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
      if (event.repeat || typingInto(event.target) || document.querySelector("dialog[open]")) return;
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
  }, [finished]);

  // The browser takes Escape for itself to release a captured mouse, so the
  // page never hears it; losing the capture mid-flight is the same request.
  useEffect(() => {
    let wasLocked = false;
    const changed = () => {
      const locked = document.pointerLockElement !== null;
      if (wasLocked && !locked && !finished && !document.querySelector("dialog[open]")) setMenuOpen(true);
      wasLocked = locked;
    };
    document.addEventListener("pointerlockchange", changed);
    return () => document.removeEventListener("pointerlockchange", changed);
  }, [finished]);

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

  const outcome = finished && match.state ? outcomeOf(match.state) : undefined;
  const viewLabel = VIEWS.find((entry) => entry.value === view)?.label ?? "";
  const opponent = OPPONENTS.find((choice) => choice.value === setup.opponent)?.label ?? "";

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
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={PLAYER} detailsOpen={telemetry} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={PLAYER} />

      <button className="hud-button game-menu-button" onClick={() => setMenuOpen(true)} aria-label="Pause menu">
        <List weight="bold" aria-hidden />
        <kbd aria-hidden>Esc</kbd>
      </button>

      <button
        className="hud-button game-view-button"
        onClick={() =>
          setView((current) => VIEWS[(VIEWS.findIndex((entry) => entry.value === current) + 1) % VIEWS.length]!.value)
        }
        aria-label={`Camera: ${viewLabel}. Change camera`}
      >
        <kbd aria-hidden>V</kbd>
        <span aria-hidden>{viewLabel}</span>
      </button>

      {pointerFlying && match.canCapturePointer && !holding && !finished ? (
        <button className="capture-hint" onClick={() => void match.inputRef.current.requestPointerLock()}>
          Click to take the stick with your mouse
        </button>
      ) : null}

      {telemetry ? (
        <DetailsPanel state={match.state} followId={PLAYER} open onToggle={() => setTelemetry(false)} />
      ) : null}

      <IntroModal open={introOpen} scheme={match.scheme} onClose={closeIntro} />

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
          legend="Camera"
          name="camera"
          choices={VIEWS}
          value={view}
          onChange={setView}
          showDetail={false}
        />
        <ChoiceGroup
          legend="Controls"
          name="controls"
          choices={SCHEMES}
          value={match.scheme}
          onChange={(scheme: ControlScheme) => match.setScheme(scheme)}
          showDetail={false}
        />

        <label className="menu-toggle">
          <input type="checkbox" checked={telemetry} onChange={(event) => setTelemetry(event.target.checked)} />
          <span>Show flight telemetry</span>
        </label>

        <div className="menu-secondary">
          <button className="quiet" onClick={() => { setMenuOpen(false); setIntroOpen(true); }}>
            How to play
          </button>
          <button className="quiet" onClick={match.downloadReplay}>
            Save replay
          </button>
          <button className="quiet" onClick={() => navigate("/")}>
            Quit to menu
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
        <dl className="results-stats">
          {outcome?.stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <p className="results-context">
          Against the {opponent.toLowerCase()} pilot{setup.weapons === "fox2" ? ", with missiles" : ", guns only"}.
          {match.recording.message ? ` ${match.recording.message}.` : ""}
        </p>
        <div className="dialog-actions">
          <button className="primary large" onClick={match.restart} autoFocus>
            Fly again
          </button>
          <button className="large" onClick={() => navigate("/")}>
            Change setup
          </button>
          <button className="quiet" onClick={match.downloadReplay}>
            Save replay
          </button>
        </div>
      </Dialog>
    </div>
  );
}
