import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, Copy, List } from "@phosphor-icons/react";
import { AircraftPicker } from "../components/AircraftPicker";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { Dialog } from "../components/Dialog";
import { FlightDisplay } from "../components/FlightDisplay";
import { Silhouette } from "../components/Silhouette";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useAccount } from "../hooks/useAccount";
import { useCockpitAudio } from "../hooks/useCockpitAudio";
import { useOnlineMatch } from "../hooks/useOnlineMatch";
import { loadCallsign, saveCallsign } from "../callsign";
import { outcomeOf } from "../outcome";
import { LOADOUTS, SCHEMES, loadSetup, saveSetup, type Choice } from "../setup";
import type { ControlScheme } from "../input/pilot-input";
import { isRoomCode, NAME_MAX, type LobbyPlayer } from "../../net/protocol";
import { AIRFRAMES, airframe, type AirframeId } from "../../sim/airframes";
import type { DogfightViewer, ViewMode } from "../../viewer";

const VIEWS: ReadonlyArray<Choice<ViewMode>> = [
  { value: "chase", label: "Chase" },
  { value: "cockpit", label: "Cockpit" },
  { value: "track", label: "Target track" },
  { value: "arena", label: "Arena" },
  { value: "free", label: "Free look" },
];
const ZOOM_PER_WHEEL_PIXEL = 0.0012;
const pendingCancels = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * `/online`: asks for a room -- a fresh one to invite a friend to, or with
 * `?quick=1` a quick match -- and goes to it.
 */
export function OnlineStartPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const quick = params.get("quick") === "1";
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(quick ? "/api/online/quick" : "/api/online/rooms", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) {
          // In development the online server is a second process; a proxy with nothing behind it answers 500.
          throw new Error(
            import.meta.env.DEV && response.status >= 500
              ? "Online play isn't running. Start it with npm run dev:online."
              : `The server said ${response.status}.`,
          );
        }
        return (await response.json()) as { code: string };
      })
      .then(({ code }) => {
        if (!cancelled) navigate(`/online/${code}${quick ? "?quick=1" : ""}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, quick]);

  return (
    <main className="online-page">
      <section className="online-panel" aria-live="polite">
        {error ? (
          <>
            <h1 className="online-title">Couldn't reach the server</h1>
            <p className="online-note">{error}</p>
            <BackButton />
          </>
        ) : (
          <h1 className="online-title">{quick ? "Finding a match…" : "Making a room…"}</h1>
        )}
      </section>
    </main>
  );
}

/** `/online/:code`: the room -- its lobby, the fight, and the result. */
export function OnlineRoomPage() {
  const { code: rawCode = "" } = useParams();
  const code = rawCode.toUpperCase();
  const [params] = useSearchParams();
  const quick = params.get("quick") === "1";
  if (!isRoomCode(code)) {
    return (
      <main className="online-page">
        <section className="online-panel">
          <h1 className="online-title">No such room</h1>
          <p className="online-note">Room codes are five letters and numbers, like K7QMX.</p>
          <BackButton />
        </section>
      </main>
    );
  }
  return <OnlineRoom key={code} code={code} quick={quick} />;
}

function OnlineRoom({ code, quick }: { code: string; quick: boolean }) {
  const navigate = useNavigate();
  const account = useAccount();
  const [setup, setSetup] = useState(() => loadSetup());
  const [name, setName] = useState(() => (account.user ? account.displayName : loadCallsign()));
  const match = useOnlineMatch({ code, quick, name, aircraft: setup.aircraft, scheme: setup.scheme });
  const { lobby, seat } = match;

  // A quick match left before anyone joins should not send the next player into an empty room.
  const alone = useRef(true);
  alone.current = (lobby?.players.length ?? 0) < 2 && lobby?.phase !== "flying";
  useEffect(() => {
    if (!quick) return;
    // A remount -- React does one in development -- is not leaving, so it calls off the cancel.
    clearTimeout(pendingCancels.get(code));
    const cancel = () => {
      if (alone.current) void fetch(`/api/online/quick/cancel?code=${code}`, { method: "POST", keepalive: true });
    };
    addEventListener("pagehide", cancel);
    return () => {
      removeEventListener("pagehide", cancel);
      pendingCancels.set(code, setTimeout(cancel, 250));
    };
  }, [code, quick]);

  const phase = lobby?.phase;
  const inFight = phase === "flying" || (phase === "finished" && match.state !== undefined);

  if (match.status === "closed" && !lobby) {
    return (
      <main className="online-page">
        <section className="online-panel">
          <h1 className="online-title">Couldn't join</h1>
          <p className="online-note">{match.error ?? "The connection closed."}</p>
          <BackButton />
        </section>
      </main>
    );
  }

  if (inFight && seat) return <OnlineFlight match={match} seat={seat} onLeave={() => navigate("/")} />;

  const you = lobby?.players.find((player) => player.seat === seat);
  const other = lobby?.players.find((player) => player.seat !== seat);
  const host = lobby?.host === seat;

  return (
    <>
      <AttractBackdrop blue={you?.airframe ?? setup.aircraft} red={other?.airframe ?? you?.airframe ?? setup.aircraft} />
      <div className="home-shade" aria-hidden />
      <main className="online-page">
        <section className="online-panel online-lobby" aria-labelledby="lobby-title">
          <div className="online-head">
            <h1 id="lobby-title" className="online-title">
              {quick ? "Quick match" : "Online match"}
            </h1>
            {match.pingMs !== undefined && match.status === "open" ? (
              <span className="online-ping" title="Round trip to the server">
                {match.pingMs} ms
              </span>
            ) : null}
          </div>

          {quick ? null : <Invite code={code} />}

          <ol className="online-seats" aria-label="Pilots">
            {[you, other].map((player, index) =>
              player ? (
                <Seat key={player.seat} player={player} you={player.seat === seat} host={player.seat === lobby?.host} />
              ) : (
                <li key={`empty-${index}`} className="online-seat empty">
                  {index === 0 ? "Connecting…" : quick ? "Looking for an opponent…" : "Waiting for someone to join…"}
                </li>
              ),
            )}
          </ol>

          <label className="online-name">
            <span>Callsign</span>
            <input
              value={name}
              maxLength={NAME_MAX}
              onChange={(changed) => setName(changed.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (!trimmed) return;
                if (!account.user) saveCallsign(trimmed);
                match.rename(trimmed, you?.airframe ?? setup.aircraft);
              }}
            />
          </label>

          <AircraftPicker
            value={you?.airframe ?? setup.aircraft}
            onChange={(chosen: AirframeId) => {
              const next = { ...setup, aircraft: chosen };
              setSetup(next);
              saveSetup(next);
              match.chooseAircraft(chosen);
            }}
          />

          <div className="home-options">
            <ChoiceGroup
              legend={host ? "Weapons" : "Weapons · the host picks"}
              name="weapons"
              variant="segmented"
              choices={LOADOUTS}
              value={lobby?.weapons ?? "guns"}
              onChange={(weapons) => host && match.setWeapons(weapons)}
            />
            <ChoiceGroup
              legend="Controls"
              name="controls"
              variant="segmented"
              choices={SCHEMES}
              value={match.scheme}
              onChange={(scheme: ControlScheme) => match.setScheme(scheme)}
            />
          </div>

          {phase === "countdown" ? (
            <Countdown ms={lobby?.countdownMs} />
          ) : quick ? null : (
            <button
              className={`large home-fly ${you?.ready ? "" : "primary"}`}
              onClick={() => match.setReady(!you?.ready)}
              disabled={!you}
            >
              {you?.ready ? (other ? `Waiting for ${other.name}…` : "Ready · waiting for an opponent") : "Ready"}
            </button>
          )}

          <Link className="online-leave" to="/">
            Leave
          </Link>
        </section>
      </main>
    </>
  );
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/")}>
      Back
    </button>
  );
}

function Invite({ code }: { code: string }) {
  const link = `${location.origin}/online/${code}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="online-invite">
      <span className="online-invite-label">Send this link to a friend</span>
      <div className="online-invite-row">
        <code className="online-invite-link">{link}</code>
        <button
          type="button"
          className="quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
          aria-label="Copy the invite link"
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function Seat({ player, you, host }: { player: LobbyPlayer; you: boolean; host: boolean }) {
  return (
    <li className={`online-seat${player.ready ? " ready" : ""}`}>
      <Silhouette id={player.airframe} className="online-seat-jet" />
      <span className="online-seat-name">
        {player.name}
        {you ? <span className="online-seat-tag"> · you</span> : null}
        {host ? <span className="online-seat-tag"> · host</span> : null}
      </span>
      <span className="online-seat-aircraft">{AIRFRAMES[player.airframe].name}</span>
      <span className="online-seat-state">{player.ready ? "Ready" : "Not ready"}</span>
    </li>
  );
}

function Countdown({ ms }: { ms: number | undefined }) {
  const [left, setLeft] = useState(ms ?? 3_000);
  const started = useRef(performance.now());
  useEffect(() => {
    started.current = performance.now();
    setLeft(ms ?? 3_000);
    const timer = setInterval(() => setLeft(Math.max(0, (ms ?? 3_000) - (performance.now() - started.current))), 100);
    return () => clearInterval(timer);
  }, [ms]);
  return (
    <p className="online-countdown" role="status">
      Merging in {Math.max(1, Math.ceil(left / 1000))}
    </p>
  );
}

function OnlineFlight({
  match,
  seat,
  onLeave,
}: {
  match: ReturnType<typeof useOnlineMatch>;
  seat: string;
  onLeave: () => void;
}) {
  const viewer = useRef<DogfightViewer>(undefined);
  const [view, setView] = useState<ViewMode>("chase");
  const [menuOpen, setMenuOpen] = useState(false);
  const finished = match.lobby?.phase === "finished";
  const you = match.lobby?.players.find((player) => player.seat === seat);
  const other = match.lobby?.players.find((player) => player.seat !== seat);
  // Who it was, for the result, even after they have gone.
  const opponentName = useRef<string>(undefined);
  if (other) opponentName.current = other.name;

  useCockpitAudio(match.liveStateRef, seat, !finished);

  useEffect(() => viewer.current?.setView(view), [view]);
  const pointerFlying = match.scheme === "mouse";
  useEffect(() => viewer.current?.setPointerCaptured(pointerFlying), [pointerFlying]);

  // The fight goes on while the menu is open: there is no pausing someone else's match.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || document.querySelector("dialog[open]")) return;
      if (event.code === "Escape" || event.code === "KeyP") {
        event.preventDefault();
        if (!finished) setMenuOpen(true);
      } else if (event.code === "KeyV") {
        setView((current) => VIEWS[(VIEWS.findIndex((entry) => entry.value === current) + 1) % VIEWS.length]!.value);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
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

  const resume = useCallback(() => {
    setMenuOpen(false);
    (document.activeElement as HTMLElement | null)?.blur();
    if (match.scheme === "mouse") void match.inputRef.current.requestPointerLock();
  }, [match.scheme, match.inputRef]);

  const outcome = useMemo(
    () => (finished && match.state ? outcomeOf(match.state, seat) : undefined),
    [finished, match.state, seat],
  );
  const jets = match.state?.aircraft.map((aircraft) => airframe(aircraft.airframe).name) ?? [];

  return (
    <div className="game">
      <ViewerCanvas
        snapshotRef={match.snapshotRef}
        followId={seat}
        onReady={(instance) => {
          viewer.current = instance;
          instance.setView(view);
          instance.setPointerCaptured(pointerFlying);
        }}
      />
      <FlightDisplay stateRef={match.liveStateRef} viewerRef={viewer} followId={seat} detailsOpen={false} />
      <TacticalOverlay stateRef={match.liveStateRef} viewerRef={viewer} followId={seat} />

      <button className="hud-menu" onClick={() => setMenuOpen(true)} aria-label="Menu (Esc)" title="Menu (Esc)">
        <List aria-hidden />
      </button>
      {match.pingMs !== undefined ? <span className="online-ping in-flight">{match.pingMs} ms</span> : null}
      {match.status === "closed" && !finished ? (
        <p className="online-lost" role="alert">
          Connection lost
        </p>
      ) : null}

      {pointerFlying && match.canCapturePointer && !menuOpen && !finished ? (
        <button className="capture-hint" onClick={() => void match.inputRef.current.requestPointerLock()}>
          Click to fly with the mouse
        </button>
      ) : null}

      <Dialog open={menuOpen} onClose={resume} title="Menu" description="The fight carries on while this is open." className="menu">
        <div className="menu-primary">
          <button className="primary large" onClick={resume} autoFocus>
            Back to the fight
          </button>
          <button className="large" onClick={onLeave}>
            Leave match
          </button>
        </div>
        <ChoiceGroup
          legend="Controls"
          name="controls"
          choices={SCHEMES}
          value={match.scheme}
          onChange={(scheme: ControlScheme) => match.setScheme(scheme)}
        />
      </Dialog>

      <Dialog
        open={outcome !== undefined}
        onClose={onLeave}
        title={outcome?.headline ?? ""}
        description={outcome?.reason}
        className={`results results-${outcome?.verdict ?? "draw"}`}
        dismissible={false}
      >
        <p className="results-matchup">
          {you?.name ?? "You"} vs {opponentName.current ?? "—"} · {jets.join(" vs ")}
        </p>
        <dl className="results-stats">
          {outcome?.stats.map((stat) => (
            <div key={stat.label}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions">
          {other ? (
            <>
              <button className={`large ${you?.ready ? "" : "primary"}`} onClick={() => match.setReady(!you?.ready)} autoFocus>
                {you?.ready ? `Waiting for ${other.name}…` : other.ready ? `${other.name} wants a rematch` : "Rematch"}
              </button>
              <button className="quiet" onClick={onLeave}>
                Leave
              </button>
            </>
          ) : (
            <button className="primary large" onClick={onLeave} autoFocus>
              Back to the menu
            </button>
          )}
        </div>
      </Dialog>
    </div>
  );
}
