import { useEffect, useState } from "react";
import { api, ServerUnavailableError, type LeaderboardEntry } from "../api";

type Board = "models" | "humans" | "everyone";

const BOARD_LABELS: Record<Board, string> = {
  models: "Models",
  humans: "People",
  everyone: "Everyone",
};

const KINDS: Record<Board, string[]> = {
  models: ["model", "scripted"],
  humans: ["human"],
  everyone: ["model", "scripted", "human"],
};

export function LeaderboardPage() {
  const [board, setBoard] = useState<Board>("models");
  const [rows, setRows] = useState<LeaderboardEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setRows(undefined);
    setError(undefined);
    api
      .leaderboardOf(KINDS[board])
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof ServerUnavailableError ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [board]);

  const picker = (
    <div className="segmented" role="group" aria-label="Which leaderboard">
      {(["models", "humans", "everyone"] as const).map((option) => (
        <button key={option} aria-pressed={board === option} onClick={() => setBoard(option)}>
          {BOARD_LABELS[option]}
        </button>
      ))}
    </div>
  );

  const intro = board === "humans" ? "Guests are rated, but only listed once they attach an account." : undefined;

  const body = error ? (
    <p className="notice">{error}</p>
  ) : !rows ? (
    <p className="notice">Loading…</p>
  ) : !rows.length ? (
    <p className="notice">
      {board === "humans"
        ? "No ranked matches yet."
        : "No matches recorded yet. Run one with "}
      {board === "humans" ? null : <code>npm run bench -- --blue anthropic --red energy-fighter</code>}
    </p>
  ) : (
    <Table rows={rows} />
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Leaderboard</h1>
          {intro ? <p className="page-intro">{intro}</p> : null}
        </div>
        {picker}
      </div>
      {body}
    </main>
  );
}

function Table({ rows }: { rows: LeaderboardEntry[] }) {
  // Cost only earns a column when some entrant has spent anything.
  const paid = rows.some((row) => row.costPerMatchUsd > 0);
  const totals = rows.reduce(
    (sum, row) => ({
      matches: sum.matches + row.matches,
      cost: sum.cost + row.costUsd,
      rounds: sum.rounds + row.roundsFired,
      hits: sum.hits + row.hitsScored,
    }),
    { matches: 0, cost: 0, rounds: 0, hits: 0 },
  );

  return (
    <>
      <div className="summary">
        <Stat label="Entrants" value={String(rows.length)} />
        <Stat label="Matches" value={String(Math.round(totals.matches / 2))} />
        <Stat label="Rounds fired" value={totals.rounds.toLocaleString()} />
        <Stat label="Hits" value={String(totals.hits)} />
        {totals.cost > 0 ? <Stat label="Inference" value={`$${totals.cost.toFixed(2)}`} /> : null}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Entrant</th>
            <th>Model</th>
            <th title="Manoeuvres: the model names a manoeuvre and an autopilot flies it. Stick: it sets the controls itself.">
              Flies
            </th>
            <th className="num" title="Elo: beating a stronger opponent counts for more">
              Rating
            </th>
            <th className="num">W-L-D</th>
            <th className="num">Win rate</th>
            <th className="num" title="Hits per round fired">
              Accuracy
            </th>
            <th className="num">On target</th>
            <th className="num">Survived</th>
            <th className="num" title="Decisions that errored or missed their deadline">
              Failures
            </th>
            <th className="num">Latency</th>
            {paid ? <th className="num">$ / match</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.competitorId}>
              <td>
                <span className={`rank rank-${index + 1}`}>{index + 1}</span>
              </td>
              <td className="strong">
                {row.name}
                <span className={`badge badge-${row.kind === "human" ? "human" : row.provider}`}>
                  {row.kind === "human" ? "person" : row.provider}
                </span>
                {row.provisional ? <span className="badge">guest</span> : null}
              </td>
              <td className="muted">
                {row.kind === "model" ? row.model : "—"}
                {row.kind === "model" ? <div className="policy">prompt {row.policyVersion}</div> : null}
              </td>
              <td className="muted">{row.schema === "raw" ? "stick" : "manoeuvres"}</td>
              <td className="num strong">{row.rating.toFixed(0)}</td>
              <td className="num">{`${row.wins}-${row.losses}-${row.draws}`}</td>
              <td className="num">
                <span className="meter">
                  <span className="meter-fill" style={{ width: `${(row.winRate * 100).toFixed(0)}%` }} />
                </span>
                {(row.winRate * 100).toFixed(0)}%
              </td>
              <td className="num">{(row.accuracy * 100).toFixed(1)}%</td>
              <td className="num">{row.timeOnTargetS.toFixed(1)}s</td>
              <td className="num">{(row.survivalRate * 100).toFixed(0)}%</td>
              <td className={`num${row.failureRate > 0.05 ? " warn" : ""}`}>{(row.failureRate * 100).toFixed(1)}%</td>
              <td className="num">{row.avgLatencyMs > 0 ? `${row.avgLatencyMs.toFixed(0)} ms` : "—"}</td>
              {paid ? <td className="num">{row.costPerMatchUsd > 0 ? `$${row.costPerMatchUsd.toFixed(4)}` : "—"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>

    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

