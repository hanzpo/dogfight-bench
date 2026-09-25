import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Lightning, Robot, UsersThree } from "@phosphor-icons/react";
import { AircraftPicker } from "../components/AircraftPicker";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { useAccount } from "../hooks/useAccount";
import { loadCallsign, saveCallsign } from "../callsign";
import { AIRFRAMES } from "../../sim/airframes";
import { NAME_MAX, isRoomCode } from "../../net/protocol";
import {
  ENEMY_AIRCRAFT,
  LOADOUTS,
  OPPONENTS,
  SCHEMES,
  loadSetup,
  saveSetup,
  setupToSearch,
  type EnemyAircraft,
  type Mode,
  type Setup,
} from "../setup";

const MODE_CARDS: ReadonlyArray<{ value: Mode; title: string; line: string; icon: ReactNode }> = [
  { value: "quick", title: "Quick match", line: "Fight whoever's online", icon: <Lightning weight="fill" /> },
  { value: "friend", title: "With a friend", line: "A private room, by link or code", icon: <UsersThree weight="fill" /> },
  { value: "training", title: "Training", line: "Against the AI", icon: <Robot weight="fill" /> },
];

/** Whether someone is in the quick-match queue now, asked every little while. */
function useSomeoneWaiting(active: boolean): boolean | undefined {
  const [waiting, setWaiting] = useState<boolean>();
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const ask = () =>
      fetch("/api/online/quick/status")
        .then((response) => (response.ok ? (response.json() as Promise<{ waiting: boolean }>) : undefined))
        .then((status) => !cancelled && setWaiting(status?.waiting))
        .catch(() => !cancelled && setWaiting(undefined));
    void ask();
    const timer = setInterval(ask, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);
  return waiting;
}

export function HomePage() {
  const navigate = useNavigate();
  const account = useAccount();
  const [setup, setSetup] = useState<Setup>(() => loadSetup());
  const [callsign, setCallsign] = useState(() => loadCallsign());
  const [joinCode, setJoinCode] = useState("");
  const [touchOnly] = useState(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);
  const online = setup.mode !== "training";
  const someoneWaiting = useSomeoneWaiting(setup.mode === "quick");

  useEffect(() => saveSetup(setup), [setup]);
  // A signed-in pilot goes by their account's name until they choose another.
  useEffect(() => {
    if (account.user && /^Pilot \d+$/.test(callsign)) setCallsign(account.displayName.slice(0, NAME_MAX));
  }, [account.user, account.displayName, callsign]);

  const update = <K extends keyof Setup>(key: K) => (value: Setup[K]) => setSetup((current) => ({ ...current, [key]: value }));
  const enemy = setup.enemyAircraft === "same" ? setup.aircraft : setup.enemyAircraft;
  const code = joinCode.trim().toUpperCase();
  const jet = AIRFRAMES[setup.aircraft].name;

  const go = () => {
    if (online) saveCallsign(callsign.trim() || loadCallsign());
    if (setup.mode === "quick") navigate("/online?quick=1");
    else if (setup.mode === "friend") navigate(`/online?weapons=${setup.weapons}`);
    else navigate(`/fly${setupToSearch(setup)}`);
  };

  return (
    <>
      <AttractBackdrop blue={setup.aircraft} red={setup.mode === "training" ? enemy : setup.aircraft} />
      <div className="home-shade" aria-hidden />

      <main className="home">
        <section className="home-intro" aria-labelledby="home-title">
          <h1 id="home-title" className="home-title">
            Dogfight
          </h1>
          <p className="home-lede">One-on-one jet dogfights in your browser.</p>
        </section>

        <form
          className="home-setup"
          aria-label="Set up a flight"
          onSubmit={(event) => {
            event.preventDefault();
            go();
          }}
        >
          <fieldset className="mode-picker">
            <legend className="visually-hidden">How to fly</legend>
            {MODE_CARDS.map((mode) => (
              <label key={mode.value} className={`mode-card mode-${mode.value}`}>
                <input
                  type="radio"
                  name="mode"
                  value={mode.value}
                  checked={setup.mode === mode.value}
                  onChange={() => update("mode")(mode.value)}
                />
                <span className="mode-face">
                  <span className="mode-icon" aria-hidden>
                    {mode.icon}
                  </span>
                  <span className="mode-title">{mode.title}</span>
                  <span className="mode-line">
                    {mode.value === "quick" && someoneWaiting ? (
                      <span className="mode-live">
                        <span className="live-dot" aria-hidden /> A pilot is waiting
                      </span>
                    ) : (
                      mode.line
                    )}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <AircraftPicker value={setup.aircraft} onChange={update("aircraft")} />

          <div className="home-options">
            {online ? (
              <label className="home-callsign">
                <span>Callsign</span>
                <input
                  value={callsign}
                  maxLength={NAME_MAX}
                  autoComplete="nickname"
                  onChange={(changed) => setCallsign(changed.target.value)}
                  onBlur={() => callsign.trim() && saveCallsign(callsign.trim())}
                />
              </label>
            ) : (
              <ChoiceGroup
                legend="Opponent"
                name="opponent"
                variant="segmented"
                choices={OPPONENTS}
                value={setup.opponent}
                onChange={update("opponent")}
              >
                <label className="choice-select">
                  <span className="visually-hidden">Enemy aircraft</span>
                  <select
                    id="enemy-aircraft"
                    value={setup.enemyAircraft}
                    onChange={(changed) => update("enemyAircraft")(changed.target.value as EnemyAircraft)}
                  >
                    {ENEMY_AIRCRAFT.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.value === "same" ? "Same jet" : choice.value === "random" ? "Random jet" : `in a ${choice.label}`}
                      </option>
                    ))}
                  </select>
                </label>
              </ChoiceGroup>
            )}
            {setup.mode === "quick" ? null : (
              <ChoiceGroup
                legend="Weapons"
                name="weapons"
                variant="segmented"
                choices={LOADOUTS}
                value={setup.weapons}
                onChange={update("weapons")}
              />
            )}
            <ChoiceGroup
              legend="Controls"
              name="controls"
              variant="segmented"
              choices={SCHEMES}
              value={setup.scheme}
              onChange={update("scheme")}
            />
          </div>

          <button type="submit" className="primary large home-fly" id="fly">
            {setup.mode === "quick" ? "Find a match" : setup.mode === "friend" ? "Make a room" : `Fly the ${jet}`}
            <ArrowRight weight="bold" aria-hidden />
          </button>
          {touchOnly ? (
            <p className="home-note" role="note">
              Needs a keyboard, mouse or gamepad.
            </p>
          ) : null}
        </form>

        <form
          className="home-join"
          aria-label="Join a room by code"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isRoomCode(code)) return;
            saveCallsign(callsign.trim() || loadCallsign());
            navigate(`/online/${code}`);
          }}
        >
          <label htmlFor="join-code">Have a code?</label>
          <input
            id="join-code"
            value={joinCode}
            onChange={(changed) => setJoinCode(changed.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))}
            placeholder="K7QMX"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            aria-describedby="join-hint"
          />
          <button type="submit" disabled={!isRoomCode(code)}>
            Join
          </button>
          <span id="join-hint" className="visually-hidden">
            Five letters and numbers, from a friend's room
          </span>
        </form>

        <nav className="home-links" aria-label="More">
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/matches">Replays</Link>
          <Link to="/lab">Lab</Link>
        </nav>
      </main>
    </>
  );
}
