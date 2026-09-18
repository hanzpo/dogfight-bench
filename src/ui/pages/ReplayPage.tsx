import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, ServerUnavailableError } from "../api";
import { FlightDisplay } from "../components/FlightDisplay";
import { DetailsPanel } from "../components/DetailsPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useReplayPlayback } from "../hooks/useReplayPlayback";
import type { DogfightViewer, ViewMode } from "../../viewer";
import { parseReplay, type ReplayFile } from "../../sim/replay";

/**
 * Replay playback.
 *
 * A replay can come from the server by match id, or from a file the viewer
 * drops in, so a result someone published can be checked without running the
 * benchmark server at all.
 */
export function ReplayPage() {
  const { id } = useParams();
  const location = useLocation();
  const [replay, setReplay] = useState<ReplayFile>();
  const [error, setError] = useState<string>();
  const [followRed, setFollowRed] = useState(false);
  const [view, setView] = useState<ViewMode>("orbit");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<DogfightViewer>(undefined);
  const playback = useReplayPlayback(replay);
  const followId = followRed ? "red-1" : "blue-1";

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  /** A file chosen on the matches page arrives through the router's state. */
  useEffect(() => {
    const handed = (location.state as { file?: File } | null)?.file;
    if (handed instanceof File) void loadFile(handed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

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
            detailsOpen={detailsOpen}
          />
          <TacticalOverlay stateRef={playback.stateRef} viewerRef={viewer} followId={followId} />
          {/* The decision that was live at this moment, so a replay shows what
              the model chose and how sure it was, not only what the aircraft
              then did. */}
          <DetailsPanel
            state={playback.state}
            followId={followId}
            decision={decision}
            open={detailsOpen}
            onToggle={() => setDetailsOpen(!detailsOpen)}
          />
        </>
      ) : null}

      {!replay ? (
        <main className="page overlay-page">
          <div className="page-head">
            <div>
              <h1>Replay</h1>
              <p className="page-intro">
                A replay carries the decision log, so a published result can be checked without the model, the
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
          {id ? (
            <p className="notice">Loading replay…</p>
          ) : (
            <p className="notice">
              Pick a match from <Link to="/matches">Matches</Link>, or open a replay file saved from one.
            </p>
          )}
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
