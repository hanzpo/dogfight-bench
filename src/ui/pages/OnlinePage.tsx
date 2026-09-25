import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AircraftPicker } from "../components/AircraftPicker";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { Countdown, Elapsed, PilotCard, Radar, RoomCode, Versus } from "../components/online/Lobby";
import { OnlineFlight } from "../components/online/OnlineFlight";
import { useOnlineMatch, type OnlineMatch } from "../hooks/useOnlineMatch";
import { loadCallsign } from "../callsign";
import { tabSession } from "../session";
import { LOADOUTS, loadSetup, saveSetup } from "../setup";
import { QUICK_STAY_MS } from "../../net/matchmaker";
import { isRoomCode, SEATS } from "../../net/protocol";
import { AIRFRAMES, type AirframeId } from "../../sim/airframes";
import type { Loadout } from "../../sim/types";

const pendingCancels = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * One request for a room however often the page mounts -- React mounts it
 * twice in development -- so a quick match never asks the matchmaker twice.
 */
let roomRequest: { quick: boolean; code: Promise<string> } | undefined;

function askForRoom(quick: boolean): Promise<string> {
  if (roomRequest?.quick === quick) return roomRequest.code;
  const code = fetch(quick ? `/api/online/quick?session=${encodeURIComponent(tabSession())}` : "/api/online/rooms", {
    method: "POST",
  }).then(async (response) => {
    if (!response.ok) {
      // In development the online server is a second process; a proxy with nothing behind it answers 500.
      throw new Error(
        import.meta.env.DEV && response.status >= 500
          ? "Online play isn't running. Start it with npm run dev:online."
          : `The server said ${response.status}.`,
      );
    }
    return ((await response.json()) as { code: string }).code;
  });
  roomRequest = { quick, code };
  // Asked for afresh next time: the request is for this visit to the page, not for good.
  void code.finally(() => setTimeout(() => (roomRequest = undefined), 1_000)).catch(() => {});
  return code;
}

/** A plain panel over the backdrop, for the moments with nothing to choose: an error, a missing room. */
function Notice({ title, children }: { title: string; children?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <main className="online-page">
      <section className="online-panel" aria-live="polite">
        <h1 className="online-title">{title}</h1>
        {children}
        <button type="button" onClick={() => navigate("/")}>
          Back to the menu
        </button>
      </section>
    </main>
  );
}

/**
 * `/online`: asks for a room -- a fresh one to invite a friend to, or with
 * `?quick=1` a quick match -- and goes to it.
 */
export function OnlineStartPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const quick = params.get("quick") === "1";
  const weapons = params.get("weapons");
  const [error, setError] = useState<string>();
  const [since] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    askForRoom(quick)
      .then((code) => {
        if (cancelled) return;
        const passOn = new URLSearchParams(quick ? { quick: "1" } : weapons ? { weapons } : {});
        navigate(`/online/${code}${passOn.size ? `?${passOn}` : ""}`, { replace: true });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, quick, weapons]);

  if (error) {
    return (
      <Notice title="Couldn't reach the server">
        <p className="online-note">{error}</p>
      </Notice>
    );
  }
  return quick ? <Searching aircraft={loadSetup().aircraft} since={since} /> : <Notice title="Making a room…" />;
}

/** `/online/:code`: the room -- its lobby, the fight, and the result. */
export function OnlineRoomPage() {
  const { code: rawCode = "" } = useParams();
  const code = rawCode.toUpperCase();
  const [params] = useSearchParams();
  const quick = params.get("quick") === "1";
  const weapons = params.get("weapons");
  if (!isRoomCode(code)) {
    return (
      <Notice title="No such room">
        <p className="online-note">Room codes are five letters and numbers, like K7QMX.</p>
      </Notice>
    );
  }
  return (
    <OnlineRoom
      key={code}
      code={code}
      quick={quick}
      weapons={LOADOUTS.some((choice) => choice.value === weapons) ? (weapons as Loadout) : undefined}
    />
  );
}

function OnlineRoom({ code, quick, weapons }: { code: string; quick: boolean; weapons?: Loadout }) {
  const navigate = useNavigate();
  const [setup, setSetup] = useState(() => loadSetup());
  const [name] = useState(() => loadCallsign());
  const [arrived] = useState(() => Date.now());
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

  // Still looking: stay in the quick-match queue, and go to whoever else is waiting if there is someone.
  const searching = quick && lobby !== undefined && lobby.players.length < 2 && lobby.phase === "lobby";
  useEffect(() => {
    if (!searching) return;
    const stay = () =>
      fetch(`/api/online/quick?session=${encodeURIComponent(tabSession())}&code=${code}`, { method: "POST" })
        .then((response) => (response.ok ? (response.json() as Promise<{ code: string }>) : undefined))
        .then((answer) => {
          if (answer && answer.code !== code) navigate(`/online/${answer.code}?quick=1`, { replace: true });
        })
        .catch(() => {});
    const timer = setInterval(stay, QUICK_STAY_MS);
    return () => clearInterval(timer);
  }, [searching, code, navigate]);

  // The weapons chosen on the home page, set once the room says we are its host.
  const weaponsSet = useRef(false);
  const { setWeapons } = match;
  useEffect(() => {
    if (weaponsSet.current || !weapons || !lobby || lobby.host !== lobby.you) return;
    weaponsSet.current = true;
    if (lobby.weapons !== weapons) setWeapons(weapons);
  }, [lobby, weapons, setWeapons]);

  const leave = () => navigate("/");
  const phase = lobby?.phase;

  if (match.status === "closed" && !lobby) {
    return (
      <Notice title="Couldn't join">
        <p className="online-note">{match.error ?? "The connection closed."}</p>
      </Notice>
    );
  }
  if (match.status === "closed" && phase !== "finished") {
    return (
      <Notice title="Lost the connection">
        <p className="online-note">Your seat is held for a few seconds.</p>
        <button type="button" className="primary" onClick={() => location.reload()}>
          Try again
        </button>
      </Notice>
    );
  }
  if ((phase === "flying" || (phase === "finished" && match.state)) && seat) {
    return <OnlineFlight match={match} seat={seat} onLeave={leave} />;
  }

  const you = lobby?.players.find((player) => player.seat === seat);
  const other = lobby?.players.find((player) => player.seat !== seat);
  const mine = you?.airframe ?? setup.aircraft;

  if (quick && !other) {
    return <Searching aircraft={mine} since={arrived} name={you?.name} ping={match.pingMs} onCancel={leave} />;
  }

  return (
    <>
      <AttractBackdrop blue={mine} red={other?.airframe ?? mine} />
      <div className="home-shade" aria-hidden />
      <main className="online-page">
        {match.status === "reconnecting" ? (
          <p className="online-lost" role="status">
            Connection dropped. Reconnecting…
          </p>
        ) : null}
        {quick ? (
          <MatchFound match={match} onLeave={leave} />
        ) : (
          <PrivateRoom
            code={code}
            match={match}
            onLeave={leave}
            onChooseAircraft={(chosen) => {
              const next = { ...setup, aircraft: chosen };
              setSetup(next);
              saveSetup(next);
              match.chooseAircraft(chosen);
            }}
          />
        )}
      </main>
    </>
  );
}

/** Quick match, alone in the room: the radar sweeps until someone else looks too. */
function Searching({
  aircraft,
  since,
  name,
  ping,
  onCancel,
}: {
  aircraft: AirframeId;
  since: number;
  name?: string;
  ping?: number;
  onCancel?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <AttractBackdrop blue={aircraft} red={aircraft} />
      <div className="searching-shade" aria-hidden />
      <main className="searching" aria-live="polite" aria-labelledby="searching-title">
        <p className="searching-kicker">Quick match</p>
        <Radar airframe={aircraft} />
        <h1 id="searching-title" className="searching-title">
          Looking for an opponent
        </h1>
        <p className="searching-time">
          <Elapsed since={since} />
        </p>
        <ul className="searching-chips" aria-label="Your loadout">
          {name ? <li>{name}</li> : null}
          <li>{AIRFRAMES[aircraft].name}</li>
          <li>Guns only</li>
          {ping !== undefined ? <li>{ping} ms</li> : null}
        </ul>
        <button type="button" className="searching-cancel" onClick={onCancel ?? (() => navigate("/"))}>
          Cancel
        </button>
      </main>
    </>
  );
}

/** Quick match, paired: who you are about to fight, and the countdown to the merge. */
function MatchFound({ match, onLeave }: { match: OnlineMatch; onLeave: () => void }) {
  const { lobby, seat } = match;
  const you = lobby?.players.find((player) => player.seat === seat);
  const other = lobby?.players.find((player) => player.seat !== seat);
  return (
    <section className="online-panel matchup" aria-live="polite" aria-labelledby="matchup-title">
      <div className="online-head">
        <h1 id="matchup-title" className="online-title">
          Opponent found
        </h1>
        <Ping ms={match.pingMs} />
      </div>
      <Versus
        left={<PilotCard player={you} you seat={seat ?? "blue-1"} />}
        right={<PilotCard player={other} seat={other?.seat ?? "red-1"} />}
        middle={lobby?.phase === "countdown" ? <Countdown ms={lobby.countdownMs} /> : undefined}
      />
      <p className="matchup-rules">Guns only · Head-on from eight kilometres</p>
      <button type="button" className="quiet online-leave" onClick={onLeave}>
        Leave
      </button>
    </section>
  );
}

/** A room for two friends: its code to share, both pilots, the host's weapons, and ready. */
function PrivateRoom({
  code,
  match,
  onLeave,
  onChooseAircraft,
}: {
  code: string;
  match: OnlineMatch;
  onLeave: () => void;
  onChooseAircraft: (airframe: AirframeId) => void;
}) {
  const { lobby, seat } = match;
  const [picking, setPicking] = useState(false);
  const you = lobby?.players.find((player) => player.seat === seat);
  const other = lobby?.players.find((player) => player.seat !== seat);
  const host = lobby !== undefined && lobby.host === seat;
  const counting = lobby?.phase === "countdown";
  const otherSeat = SEATS.find((candidate) => candidate !== seat) ?? "red-1";

  return (
    <section className="online-panel room" aria-labelledby="room-title">
      <div className="online-head">
        <h1 id="room-title" className="online-title">
          Private room
        </h1>
        <Ping ms={match.pingMs} />
      </div>

      {other ? null : <RoomCode code={code} />}

      <Versus
        left={
          <PilotCard
            player={you}
            you
            host={host}
            seat={seat ?? "blue-1"}
            action={
              counting || !you ? null : (
                <button
                  type="button"
                  className="quiet pilot-change"
                  onClick={() => setPicking((open) => !open)}
                  aria-expanded={picking}
                >
                  {picking ? "Done" : "Change jet"}
                </button>
              )
            }
          />
        }
        right={
          <PilotCard
            player={other}
            host={other !== undefined && lobby?.host === other.seat}
            seat={otherSeat}
            placeholder="Waiting for your friend"
          />
        }
        middle={counting ? <Countdown ms={lobby?.countdownMs} /> : undefined}
      />

      {picking && !counting ? <AircraftPicker value={you?.airframe ?? "f16c"} onChange={onChooseAircraft} /> : null}

      {host && !counting ? (
        <ChoiceGroup
          legend="Weapons"
          name="weapons"
          variant="segmented"
          choices={LOADOUTS}
          value={lobby?.weapons ?? "guns"}
          onChange={(weapons) => match.setWeapons(weapons)}
        />
      ) : (
        <p className="room-rules">
          {LOADOUTS.find((choice) => choice.value === lobby?.weapons)?.label ?? "Guns only"}
          {host ? "" : " · chosen by the host"}
        </p>
      )}

      {counting ? null : (
        <button
          type="button"
          className={`large home-fly${you?.ready ? "" : " primary"}`}
          onClick={() => match.setReady(!you?.ready)}
          disabled={!you}
        >
          {you?.ready
            ? other
              ? `Ready · waiting for ${other.name}`
              : "Ready · waiting for your friend"
            : other?.ready
              ? `${other.name} is ready. Ready up`
              : "Ready"}
        </button>
      )}

      {other ? <p className="room-code-small">Room {code}</p> : null}
      <button type="button" className="quiet online-leave" onClick={onLeave}>
        Leave room
      </button>
    </section>
  );
}

function Ping({ ms }: { ms?: number }) {
  return ms === undefined ? null : (
    <span className="online-ping" title="Round trip to the server">
      {ms} ms
    </span>
  );
}
