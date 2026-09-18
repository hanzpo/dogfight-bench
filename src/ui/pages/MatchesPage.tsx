import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ServerUnavailableError, type MatchRow } from "../api";
import { authHeaders } from "../auth";
import { useAccount } from "../hooks/useAccount";

type Scope = "all" | "mine";

/**
 * Match history, and the replay browser.
 *
 * Two views of the same list: everything this deployment has recorded, and the
 * signed-in player's own matches. The second is the point of keeping replays at
 * all -- a benchmark you can only read the score of is much less useful than
 * one you can go back and watch.
 */
export function MatchesPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [rows, setRows] = useState<MatchRow[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setRows(undefined);
    setError(undefined);
    try {
      setRows(scope === "mine" ? await api.myMatches(await authHeaders()) : await api.matches());
    } catch (cause: unknown) {
      setError(cause instanceof ServerUnavailableError ? cause.message : String(cause));
    }
  }, [scope]);

  useEffect(() => {
    void load();
  }, [load, account.user?.id]);

  // Signing out while looking at your own matches should not leave them on screen.
  useEffect(() => {
    if (scope === "mine" && !account.loading && !account.user) setScope("all");
  }, [scope, account.loading, account.user]);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Matches</h1>
          <p className="page-intro">
            Every recorded match, and the replay it was recorded from. Watching one puts you back in the cockpit with
            the instruments the pilot had. Replays are stored compressed and only for matches that were actually
            reported, so an abandoned session leaves nothing behind.
          </p>
        </div>
        <div className="page-actions">
          {account.user ? (
            <div className="segmented" role="group" aria-label="Which matches">
              <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                Everyone
              </button>
              <button aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>
                Mine
              </button>
            </div>
          ) : null}
          {/* A replay somebody sent you, or one saved from a match here. */}
          <button onClick={() => fileInput.current?.click()}>Open a file</button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(changed) => {
              const file = changed.target.files?.[0];
              if (file) navigate("/replay", { state: { file } });
            }}
          />
        </div>
      </div>

      {error ? <p className="notice">{error}</p> : null}
      {!error && !rows ? <p className="notice">Loading…</p> : null}
      {!error && rows && !rows.length ? (
        <p className="notice">
          {scope === "mine"
            ? "You have not flown a recorded match yet. Fly one against a model and it will appear here."
            : "No matches recorded yet."}
        </p>
      ) : null}

      {rows && rows.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Entrants</th>
              <th>Result</th>
              <th className="num">Duration</th>
              <th className="num">Cost</th>
              <th>Origin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cost = row.participants.reduce((sum, participant) => sum + participant.costUsd, 0);
              const winner = row.participants.find((participant) => participant.competitorId === row.winner);
              return (
                <tr key={row.id}>
                  <td className="muted">{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.participants.map((participant) => participant.name).join(" vs ")}</td>
                  <td className="strong">
                    {winner?.name ?? "draw"}
                    <span className="muted"> · {row.reason}</span>
                  </td>
                  <td className="num">{row.durationS.toFixed(0)}s</td>
                  <td className="num">{cost > 0 ? `$${cost.toFixed(4)}` : "—"}</td>
                  <td className="muted">
                    {row.origin === "live" ? (row.verified ? "flown · served here" : "flown") : "benchmark"}
                  </td>
                  <td>
                    <Link to={`/replay/${row.id}`}>Watch</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </main>
  );
}
