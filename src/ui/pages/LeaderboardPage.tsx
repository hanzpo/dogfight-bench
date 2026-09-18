import { useEffect, useState } from "react";
import { api, ServerUnavailableError, type LeaderboardEntry } from "../api";

export function LeaderboardPage() {
  const [rows, setRows] = useState<LeaderboardEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .leaderboard()
      .then(setRows)
      .catch((cause: unknown) =>
        setError(cause instanceof ServerUnavailableError ? cause.message : String(cause)),
      );
  }, []);

  if (error) return <Panel title="LEADERBOARD"><p className="notice">{error}</p></Panel>;
  if (!rows) return <Panel title="LEADERBOARD"><p className="notice">Loading…</p></Panel>;
  if (!rows.length) {
    return (
      <Panel title="LEADERBOARD">
        <p className="notice">
          No matches recorded yet. Run one with <code>npm run bench -- --blue anthropic --red energy-fighter</code>.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="LEADERBOARD">
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>AGENT</th>
            <th>MODEL</th>
            <th className="num">RATING</th>
            <th className="num">W-L-D</th>
            <th className="num">WIN%</th>
            <th className="num">ACCURACY</th>
            <th className="num">ON TARGET</th>
            <th className="num">SURVIVED</th>
            <th className="num">FAIL%</th>
            <th className="num">LATENCY</th>
            <th className="num">$/MATCH</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.agentId}>
              <td>{index + 1}</td>
              <td className="strong">{row.name}</td>
              <td className="muted">{row.provider === "scripted" ? "—" : row.model}</td>
              <td className="num strong">{row.rating.toFixed(0)}</td>
              <td className="num">{`${row.wins}-${row.losses}-${row.draws}`}</td>
              <td className="num">{(row.winRate * 100).toFixed(0)}%</td>
              <td className="num">{(row.accuracy * 100).toFixed(1)}%</td>
              <td className="num">{row.timeOnTargetS.toFixed(1)}s</td>
              <td className="num">{(row.survivalRate * 100).toFixed(0)}%</td>
              <td className={`num${row.failureRate > 0.05 ? " warn" : ""}`}>{(row.failureRate * 100).toFixed(1)}%</td>
              <td className="num">{row.avgLatencyMs.toFixed(0)} ms</td>
              <td className="num">{row.costPerMatchUsd > 0 ? `$${row.costPerMatchUsd.toFixed(4)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="footnote">
        Rating is Elo, so beating a strong opponent counts for more than beating a weak one. Accuracy is hits per round
        fired. Fail% counts decisions that errored or missed their deadline.
      </p>
    </Panel>
  );
}

export function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {children}
    </main>
  );
}
