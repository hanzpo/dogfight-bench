import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, LinkSimple } from "@phosphor-icons/react";
import { Silhouette } from "../Silhouette";
import type { LobbyPlayer, Seat } from "../../../net/protocol";
import { AIRFRAMES, type AirframeId } from "../../../sim/airframes";

/** Blue is the room's first seat and red its second, as the jets are tinted in the air. */
function team(seat: Seat): "blue" | "red" {
  return seat === "blue-1" ? "blue" : "red";
}

/** One side of the matchup: the pilot, their jet seen from above, and whether they are ready. */
export function PilotCard({
  player,
  you,
  host,
  seat,
  placeholder,
  action,
}: {
  player?: LobbyPlayer;
  you?: boolean;
  host?: boolean;
  /** For an empty seat: which side it is. */
  seat: Seat;
  placeholder?: ReactNode;
  action?: ReactNode;
}) {
  if (!player) {
    return (
      <div className={`pilot-card empty team-${team(seat)}`}>
        <div className="pilot-jet pilot-jet-empty" aria-hidden />
        <p className="pilot-waiting">{placeholder}</p>
      </div>
    );
  }
  return (
    <div className={`pilot-card team-${team(player.seat)}${player.ready ? " ready" : ""}`}>
      <Silhouette id={player.airframe} className="pilot-jet" />
      <p className="pilot-name">
        {player.name}
        {you ? <span className="pilot-tag">You</span> : null}
        {host && !you ? <span className="pilot-tag">Host</span> : null}
      </p>
      <p className="pilot-aircraft">
        {AIRFRAMES[player.airframe].name} · {AIRFRAMES[player.airframe].role}
      </p>
      <p className="pilot-state">{player.ready ? "Ready" : "Not ready"}</p>
      {action}
    </div>
  );
}

/** The two pilots facing each other, with whatever belongs between them: "vs", or the countdown. */
export function Versus({ left, right, middle }: { left: ReactNode; right: ReactNode; middle?: ReactNode }) {
  return (
    <div className="versus">
      {left}
      <div className="versus-middle" aria-hidden={middle === undefined}>
        {middle ?? <span className="versus-vs">vs</span>}
      </div>
      {right}
    </div>
  );
}

/** Seconds to the merge, counted down from what the room said. */
export function Countdown({ ms }: { ms: number | undefined }) {
  const total = ms ?? 3_000;
  const [left, setLeft] = useState(total);
  const started = useRef(performance.now());
  useEffect(() => {
    started.current = performance.now();
    setLeft(total);
    const timer = setInterval(() => setLeft(Math.max(0, total - (performance.now() - started.current))), 100);
    return () => clearInterval(timer);
  }, [total]);
  const seconds = Math.max(1, Math.ceil(left / 1000));
  return (
    <div className="countdown" role="status" aria-label={`Merging in ${seconds}`}>
      <span key={seconds} className="countdown-number">
        {seconds}
      </span>
      <span className="countdown-label">Merge</span>
    </div>
  );
}

/** A radar scope sweeping for contacts, with the player's own jet in the middle of it. */
export function Radar({ airframe, found }: { airframe: AirframeId; found?: boolean }) {
  return (
    <div className={`radar${found ? " found" : ""}`} aria-hidden>
      <div className="radar-rings" />
      <div className="radar-sweep" />
      {found ? <div className="radar-contact" /> : null}
      <Silhouette id={airframe} className="radar-jet" />
    </div>
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    copied,
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1_500);
      });
    },
  ];
}

/** The room's code, big enough to read out, and its link to send. */
export function RoomCode({ code }: { code: string }) {
  const link = `${location.origin}/online/${code}`;
  const [linkCopied, copyLink] = useCopied();
  const [codeCopied, copyCode] = useCopied();
  return (
    <div className="room-code">
      <span className="room-code-label">Room code</span>
      <span className="room-code-value" aria-label={code.split("").join(" ")}>
        {code}
      </span>
      <div className="room-code-actions">
        <button type="button" className="primary" onClick={() => copyLink(link)}>
          {linkCopied ? <Check aria-hidden /> : <LinkSimple aria-hidden />}
          {linkCopied ? "Link copied" : "Copy invite link"}
        </button>
        <button type="button" onClick={() => copyCode(code)}>
          {codeCopied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {codeCopied ? "Copied" : "Copy code"}
        </button>
      </div>
    </div>
  );
}

/** Minutes and seconds since `since`, ticking. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="elapsed">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}
