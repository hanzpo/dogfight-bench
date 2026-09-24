import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { AircraftPicker } from "../components/AircraftPicker";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { AIRFRAMES } from "../../sim/airframes";
import {
  ENEMY_AIRCRAFT,
  LOADOUTS,
  OPPONENTS,
  SCHEMES,
  loadSetup,
  saveSetup,
  setupToSearch,
  type EnemyAircraft,
  type Setup,
} from "../setup";

export function HomePage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<Setup>(() => loadSetup());
  const [touchOnly] = useState(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);

  useEffect(() => saveSetup(setup), [setup]);

  const update = <K extends keyof Setup>(key: K) => (value: Setup[K]) => setSetup((current) => ({ ...current, [key]: value }));
  const enemy = setup.enemyAircraft === "same" ? setup.aircraft : setup.enemyAircraft;

  return (
    <>
      <AttractBackdrop blue={setup.aircraft} red={enemy} />
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
            navigate(`/fly${setupToSearch(setup)}`);
          }}
        >
          <AircraftPicker value={setup.aircraft} onChange={update("aircraft")} />

          <div className="home-options">
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
            <ChoiceGroup
              legend="Weapons"
              name="weapons"
              variant="segmented"
              choices={LOADOUTS}
              value={setup.weapons}
              onChange={update("weapons")}
            />
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
            Fly the {AIRFRAMES[setup.aircraft].name}
            <ArrowRight weight="bold" aria-hidden />
          </button>
          {touchOnly ? (
            <p className="home-note" role="note">
              Needs a keyboard, mouse or gamepad.
            </p>
          ) : null}
        </form>

        <section className="home-online" aria-labelledby="home-online-title">
          <h2 id="home-online-title" className="home-online-title">
            Against a person
          </h2>
          <div className="home-online-actions">
            <button type="button" className="large" onClick={() => navigate("/online?quick=1")}>
              Quick match
            </button>
            <button type="button" className="large" onClick={() => navigate("/online")}>
              Invite a friend
            </button>
          </div>
        </section>

        <nav className="home-links" aria-label="More">
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/matches">Replays</Link>
          <Link to="/lab">Lab</Link>
        </nav>
      </main>
    </>
  );
}
