import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen } from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router-dom";
import { api, ServerUnavailableError, type MatchRow } from "../api";
import { authHeaders } from "../auth";
import { useAccount } from "../hooks/useAccount";

type Scope = "all" | "mine";

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

  useEffect(() => {
    if (scope === "mine" && !account.loading && !account.user) setScope("all");
  }, [scope, account.loading, account.user]);

  const anyCost = rows?.some((row) => row.participants.some((participant) => participant.costUsd > 0)) ?? false;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Replays</h1>
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
          <button onClick={() => fileInput.current?.click()}>
            <FolderOpen />
            Open a file
          </button>
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
            ? "Nothing of yours yet. Matches against a model are recorded."
            : "Nothing recorded yet."}
        </p>
      ) : null}

      {rows && rows.length ? (
        // Cost is only a column when something here cost anything.
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Entrants</th>
              <th>Result</th>
              <th className="num">Duration</th>
              {anyCost ? <th className="num">Cost</th> : null}
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
                  {anyCost ? <td className="num">{cost > 0 ? `$${cost.toFixed(4)}` : "—"}</td> : null}
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
