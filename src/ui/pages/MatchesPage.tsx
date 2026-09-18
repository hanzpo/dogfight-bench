import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ServerUnavailableError, type MatchRow } from "../api";
import { Panel } from "./LeaderboardPage";

export function MatchesPage() {
  const [rows, setRows] = useState<MatchRow[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .matches()
      .then(setRows)
      .catch((cause: unknown) =>
        setError(cause instanceof ServerUnavailableError ? cause.message : String(cause)),
      );
  }, []);

  if (error) return <Panel title="MATCH HISTORY"><p className="notice">{error}</p></Panel>;
  if (!rows) return <Panel title="MATCH HISTORY"><p className="notice">Loading…</p></Panel>;
  if (!rows.length) return <Panel title="MATCH HISTORY"><p className="notice">No matches recorded yet.</p></Panel>;

  return (
    <Panel title="MATCH HISTORY">
      <table className="data">
        <thead>
          <tr>
            <th>WHEN</th>
            <th>SCENARIO</th>
            <th>ENTRANTS</th>
            <th>RESULT</th>
            <th className="num">DURATION</th>
            <th className="num">COST</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cost = row.participants.reduce((sum, participant) => sum + participant.costUsd, 0);
            return (
              <tr key={row.id}>
                <td className="muted">{new Date(row.createdAt).toLocaleString()}</td>
                <td className="muted">{row.scenarioId}</td>
                <td>{row.participants.map((participant) => participant.agentId).join(" vs ")}</td>
                <td className="strong">{row.winnerAgent ?? "draw"}<span className="muted"> · {row.reason}</span></td>
                <td className="num">{row.durationS.toFixed(0)}s</td>
                <td className="num">{cost > 0 ? `$${cost.toFixed(4)}` : "—"}</td>
                <td><Link to={`/replay/${row.id}`}>WATCH</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
