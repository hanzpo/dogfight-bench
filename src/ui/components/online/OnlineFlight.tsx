import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List } from "@phosphor-icons/react";
import { ChoiceGroup } from "../ChoiceGroup";
import { Dialog } from "../Dialog";
import { FlightDisplay } from "../FlightDisplay";
import { TacticalOverlay } from "../TacticalOverlay";
import { ViewerCanvas } from "../ViewerCanvas";
import { useCockpitAudio } from "../../hooks/useCockpitAudio";
import type { OnlineMatch } from "../../hooks/useOnlineMatch";
import { outcomeOf } from "../../outcome";
import { SCHEMES } from "../../setup";
import { useFlightView } from "../../hooks/useFlightView";
import type { ControlScheme } from "../../input/pilot-input";
import { airframe } from "../../../sim/airframes";
import type { DogfightViewer } from "../../../viewer";


/**
 * The fight itself, and its result: the offline game's view, HUD and menus,
 * except that nothing pauses -- the other pilot is still flying.
 */
export function OnlineFlight({
  match,
  seat,
  onLeave,
}: {
  match: OnlineMatch;
  seat: string;
  onLeave: () => void;
}) {
  const viewer = useRef<DogfightViewer>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const finished = match.lobby?.phase === "finished";
  const you = match.lobby?.players.find((player) => player.seat === seat);
  const other = match.lobby?.players.find((player) => player.seat !== seat);
  // Who it was, for the result, even after they have gone.
  const opponentName = useRef<string>(undefined);
  if (other) opponentName.current = other.name;

  useCockpitAudio(match.liveStateRef, seat, !finished);

  const openMenu = useCallback(() => setMenuOpen(true), []);
  const { view } = useFlightView({ viewerRef: viewer, inputRef: match.inputRef, enabled: true, menu: !finished, onMenu: openMenu });
  const pointerFlying = match.scheme === "mouse";
  useEffect(() => viewer.current?.setPointerCaptured(pointerFlying), [pointerFlying]);

  // The fight goes on while the menu is open: there is no pausing someone else's match.

  useEffect(() => {
    if (finished) match.inputRef.current.releasePointerLock();
  }, [finished, match.inputRef]);


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
      {(match.status === "closed" || match.status === "reconnecting") && !finished ? (
        <p className="online-lost" role="alert">
          {match.status === "reconnecting" ? "Connection dropped. Reconnecting…" : "Connection lost"}
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
