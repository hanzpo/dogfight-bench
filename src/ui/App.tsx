import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { AccountMenu } from "./components/AccountMenu";
import { GamePage } from "./pages/GamePage";
import { HomePage } from "./pages/HomePage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { LivePage } from "./pages/LivePage";
import { MatchesPage } from "./pages/MatchesPage";
import { ReplayPage } from "./pages/ReplayPage";

export function App() {
  const location = useLocation();
  // In flight the screen belongs to the HUD; the pause menu is the way out.
  const inFlight = location.pathname === "/fly";

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {inFlight ? null : (
        <header className={`topbar${location.pathname === "/" ? " topbar-home" : ""}`}>
          <NavLink to="/" className="brand" aria-label="Dogfight, home">
            <span className="mark" aria-hidden>
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path d="M12 2 L14 10 L22 14 L22 16 L14 14 L13.4 19 L16 21 L16 22 L12 21 L8 22 L8 21 L10.6 19 L10 14 L2 16 L2 14 L10 10 Z" fill="currentColor" />
              </svg>
            </span>
            <span>Dogfight</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Play
            </NavLink>
            <NavLink to="/leaderboard">Leaderboard</NavLink>
            <NavLink to="/matches">Replays</NavLink>
            <NavLink to="/lab">Lab</NavLink>
            <AccountMenu />
          </nav>
        </header>
      )}

      <div id="main" tabIndex={-1} className="route">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/fly" element={<GamePage />} />
          <Route path="/lab" element={<LivePage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/matches" element={<MatchesPage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/replay/:id" element={<ReplayPage />} />
        </Routes>
      </div>
    </>
  );
}
