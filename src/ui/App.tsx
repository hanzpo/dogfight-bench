import { NavLink, Route, Routes } from "react-router-dom";
import { AccountMenu } from "./components/AccountMenu";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { LivePage } from "./pages/LivePage";
import { MatchesPage } from "./pages/MatchesPage";
import { ReplayPage } from "./pages/ReplayPage";

export function App() {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark">DB</span>
          <div>
            Dogfight <b>Bench</b>
          </div>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Fly
          </NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/matches">Matches</NavLink>
          <AccountMenu />
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<LivePage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/replay" element={<ReplayPage />} />
        <Route path="/replay/:id" element={<ReplayPage />} />
      </Routes>
    </>
  );
}
