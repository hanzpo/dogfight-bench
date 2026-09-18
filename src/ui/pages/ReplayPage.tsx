import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ServerUnavailableError, type MatchRow } from "../api";
import { authHeaders } from "../auth";
import { useAccount } from "../hooks/useAccount";
import { FlightDisplay } from "../components/FlightDisplay";
import { ObserverPanel } from "../components/ObserverPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useReplayPlayback } from "../hooks/useReplayPlayback";
import type { DogfightViewer, ViewMode } from "../../viewer";
import { parseReplay, type ReplayFile } from "../../sim/replay";

/**
 * Everything there is to watch.
 *
 * The page used to be a file picker and nothing else, which made "Replays" a
 * dead end that told people to go and look somewhere they had not been told
 * about. It lists what is actually there instead, with a player's own matches
 * first when they are signed in.
 */
function ReplayLibrary() {
  const account = useAccount();
  const [mine, setMine] = useState<MatchRow[]>();
  const [recent, setRecent] = useState<MatchRow[]>();
  const [failed, setFailed] = useState<string>();

  const load = useCallback(async () => {
    try {
      setRecent(await api.matches());
      if (account.user) setMine(await api.myMatches(await authHeaders()));
      else setMine(undefined);
    } catch (cause: unknown) {
      setFailed(cause instanceof ServerUnavailableError ? cause.message : String(cause));
    }
  }, [account.user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <p className="notice">{failed}</p>;
  if (!recent) return <p className="notice">Loading…</p>;

  const sections: Array<{ title: string; note: string; rows: MatchRow[] }> = [];
  if (mine?.length) {
    sections.push({ title: "Yours", note: "Matches you flew.", rows: mine });
  }
  sections.push({
    title: mine?.length ? "Everyone" : "Recent matches",
    note: "Every match this deployment has recorded.",
    rows: recent,
  });

  return (
    <>
      {sections.map((section) => (
        <section className="replay-section" key={section.title}>
          <h2>{section.title}</h2>
          {section.rows.length ? (
            <ul className="replay-list">
              {section.rows.slice(0, 24).map((row) => {
                const winner = row.participants.find((participant) => participant.competitorId === row.winner);
                return (
                  <li key={row.id}>
                    <Link to={`/replay/${row.id}`}>
                      <span className="replay-card-title">
                        {row.participants.map((participant) => participant.name).join(" vs ")}
                      </span>
                      <span className="replay-card-line">
                        {winner ? `${winner.name} won` : "Draw"}
                        <span className="muted"> · {row.reason}</span>
                      </span>
                      <span className="replay-card-line muted">
                        {new Date(row.createdAt).toLocaleString()} · {row.durationS.toFixed(0)}s ·{" "}
                        {row.origin === "live" ? "flown" : "benchmark"}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="notice">Nothing here yet.</p>
          )}
        </section>
      ))}
    </>
  );
}

/**
 * Replay playback.
 *
 * A replay can come from the server by match id, or from a file the viewer
 * drops in, so a result someone published can be checked without running the
 * benchmark server at all.
 */
export function ReplayPage() {
  const { id } = useParams();
  const [replay, setReplay] = useState<ReplayFile>();
  const [error, setError] = useState<string>();
  const [followRed, setFollowRed] = useState(false);
  const [view, setView] = useState<ViewMode>("orbit");
  const [observerOpen, setObserverOpen] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<DogfightViewer>(undefined);
  const playback = useReplayPlayback(replay);
  const followId = followRed ? "red-1" : "blue-1";

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  useEffect(() => {
    if (!id) return;
    setError(undefined);
    api
      .replay(id)
      .then(setReplay)
      .catch((cause: unknown) =>
        setError(cause instanceof ServerUnavailableError ? cause.message : String(cause)),
      );
  }, [id]);

  async function loadFile(file: File) {
    try {
      setReplay(parseReplay(await file.text()));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const decision = replay?.decisions.findLast(
    (record) => record.time <= playback.time && record.aircraftId === (followRed ? "red-1" : "blue-1"),
  );

  return (
    <>
      <ViewerCanvas
        snapshotRef={playback.snapshotRef}
        followId={followId}
        onReady={(instance) => {
          viewer.current = instance;
          instance.setView(view);
        }}
      />
      {replay ? (
        <>
          {/* A replay shows the same instruments the pilot had, so a decision
              can be judged against what was actually on the display. */}
          <FlightDisplay
            stateRef={playback.stateRef}
            viewerRef={viewer}
            followId={followId}
            observerOpen={observerOpen}
          />
          <TacticalOverlay stateRef={playback.stateRef} viewerRef={viewer} followId={followId} />
          {/* The decision that was live at this moment, so a replay shows what
              the model chose and how sure it was, not only what the aircraft
              then did. */}
          <ObserverPanel
            state={playback.state}
            followId={followId}
            decision={decision}
            open={observerOpen}
            onToggle={() => setObserverOpen(!observerOpen)}
          />
        </>
      ) : null}

      {!replay ? (
        <main className="page overlay-page">
          <div className="page-head">
            <div>
              <h1>Replays</h1>
              <p className="page-intro">
                Watch a recorded match back with the same instruments the pilot had, or open a replay file saved from
                one. A replay carries the decision log, so a published result can be checked without the model, the
                credentials or the server that produced it.
              </p>
            </div>
            <button onClick={() => fileInput.current?.click()}>Open a file</button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(changed) => {
              const file = changed.target.files?.[0];
              if (file) void loadFile(file);
            }}
          />
          {error ? <p className="notice">{error}</p> : null}
          {id ? <p className="notice">Loading replay…</p> : <ReplayLibrary />}
        </main>
      ) : null}

      {replay ? (
        <>
          <div className="replay-meta">
            <div>
              <strong>{replay.scenario.id}</strong>
              <span className="muted"> · seed {replay.scenario.seed}</span>
            </div>
            <div className="muted">
              {Object.entries(replay.agents)
                .map(([aircraft, info]) => `${aircraft}: ${info.name}`)
                .join("  ·  ")}
            </div>
            {replay.summary ? (
              <div>
                {replay.summary.winnerId ?? "draw"} <span className="muted">· {replay.summary.reason}</span>
              </div>
            ) : null}
            {decision?.rationale ? <div className="rationale">“{decision.rationale}”</div> : null}
          </div>

          <footer className="controls">
            <button onClick={() => playback.setPlaying(!playback.playing)}>
              {playback.playing ? "Pause" : "Play"}
            </button>
            <input
              className="scrubber"
              type="range"
              min={0}
              max={playback.duration}
              step={0.05}
              value={playback.time}
              onChange={(changed) => {
                playback.setPlaying(false);
                playback.setTime(Number(changed.target.value));
              }}
            />
            <span className="timecode">
              {playback.time.toFixed(1)} / {playback.duration.toFixed(1)}s
            </span>
            <label>
              View
              <select id="view" value={view} onChange={(changed) => setView(changed.target.value as ViewMode)}>
                <option value="orbit">External</option>
                <option value="cockpit">Cockpit</option>
              </select>
            </label>
            <label>
              Speed
              <select value={playback.speed} onChange={(changed) => playback.setSpeed(Number(changed.target.value))}>
                <option value="0.25">0.25×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </label>
            <button onClick={() => setFollowRed(!followRed)}>{followRed ? "Follow blue" : "Follow red"}</button>
          </footer>
        </>
      ) : null}
    </>
  );
}
