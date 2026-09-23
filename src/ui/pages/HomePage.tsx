import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight } from "@phosphor-icons/react";
import { AttractBackdrop } from "../components/AttractBackdrop";
import { ChoiceGroup } from "../components/ChoiceGroup";
import { IntroModal } from "../components/IntroModal";
import {
  LOADOUTS,
  OPPONENTS,
  SCHEMES,
  loadSetup,
  saveSetup,
  setupToSearch,
  type Setup,
} from "../setup";

export function HomePage() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<Setup>(() => loadSetup());
  const [introOpen, setIntroOpen] = useState(false);
  const [touchOnly] = useState(() => matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);

  useEffect(() => saveSetup(setup), [setup]);

  const update = <K extends keyof Setup>(key: K) => (value: Setup[K]) => setSetup((current) => ({ ...current, [key]: value }));

  return (
    <>
      <AttractBackdrop />
      <div className="home-shade" aria-hidden />

      <main className="home">
        <section className="home-intro" aria-labelledby="home-title">
          <p className="home-kicker">F-16 · one versus one · real flight model</p>
          <h1 id="home-title" className="home-title">
            Dogfight
          </h1>
          <p className="home-lede">
            A close-in air fight against a computer pilot. Out-turn it, out-think it, and get your guns on it first.
          </p>
        </section>

        <form
          className="home-setup"
          aria-label="Set up a flight"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(`/fly${setupToSearch(setup)}`);
          }}
        >
          <ChoiceGroup legend="Opponent" name="opponent" choices={OPPONENTS} value={setup.opponent} onChange={update("opponent")} />
          <ChoiceGroup legend="Weapons" name="weapons" choices={LOADOUTS} value={setup.weapons} onChange={update("weapons")} />
          <ChoiceGroup legend="Controls" name="controls" choices={SCHEMES} value={setup.scheme} onChange={update("scheme")} />

          <div className="home-actions">
            <button type="submit" className="primary large" id="fly">
              Fly
              <ArrowRight weight="bold" aria-hidden />
            </button>
            <button type="button" className="quiet" onClick={() => setIntroOpen(true)}>
              How to play
            </button>
          </div>
          {touchOnly ? (
            <p className="home-note" role="note">
              This needs a keyboard, a mouse or a gamepad. On a phone or tablet you can still watch the replays.
            </p>
          ) : null}
        </form>

        <nav className="home-links" aria-label="More">
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/matches">Replays</Link>
          <Link to="/lab">AI benchmark lab</Link>
        </nav>
      </main>

      <IntroModal open={introOpen} scheme={setup.scheme} onClose={() => setIntroOpen(false)} />
    </>
  );
}
