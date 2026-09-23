import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import {
  AIRCRAFT,
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

  return (
    <>
      <AttractBackdrop />
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
          <ChoiceGroup
            legend="Aircraft"
            name="aircraft"
            choices={AIRCRAFT}
            value={setup.aircraft}
            onChange={update("aircraft")}
            caption={AIRCRAFT.find((choice) => choice.value === setup.aircraft)?.role}
          />
          <ChoiceGroup legend="Opponent" name="opponent" choices={OPPONENTS} value={setup.opponent} onChange={update("opponent")}>
            <label className="choice-select">
              <span className="visually-hidden">Enemy aircraft</span>
              <select
                id="enemy-aircraft"
                value={setup.enemyAircraft}
                onChange={(changed) => update("enemyAircraft")(changed.target.value as EnemyAircraft)}
              >
                {ENEMY_AIRCRAFT.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.value === "same" || choice.value === "random" ? choice.label : `vs ${choice.label}`}
                  </option>
                ))}
              </select>
            </label>
          </ChoiceGroup>
          <ChoiceGroup legend="Weapons" name="weapons" choices={LOADOUTS} value={setup.weapons} onChange={update("weapons")} />
          <ChoiceGroup legend="Controls" name="controls" choices={SCHEMES} value={setup.scheme} onChange={update("scheme")} />

          <div className="home-actions">
            <button type="submit" className="primary large" id="fly">
              Fly
              <ArrowRight weight="bold" aria-hidden />
            </button>
          </div>
          {touchOnly ? (
            <p className="home-note" role="note">
              Needs a keyboard, mouse or gamepad.
            </p>
          ) : null}
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
