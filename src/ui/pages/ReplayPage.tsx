import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ServerUnavailableError } from "../api";
import { FlightDisplay } from "../components/FlightDisplay";
import { ObserverPanel } from "../components/ObserverPanel";
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
          <ObserverPanel
            state={playback.state}
            followId={followId}
            open={observerOpen}
            onToggle={() => setObserverOpen(!observerOpen)}
          />
        </>
      ) : null}

      {!replay ? (
        <main className="page overlay-page">
          <h1>REPLAY</h1>
          {error ? <p className="notice">{error}</p> : null}
          <p className="notice">
            {id ? "Loading replay…" : "Open a replay file saved from a match, or pick one from the match history."}
          </p>
          <button onClick={() => fileInput.current?.click()}>OPEN REPLAY FILE</button>
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
              {playback.playing ? "PAUSE" : "PLAY"}
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
              VIEW
              <select id="view" value={view} onChange={(changed) => setView(changed.target.value as ViewMode)}>
                <option value="orbit">EXTERNAL</option>
                <option value="cockpit">COCKPIT</option>
              </select>
            </label>
            <label>
              SPEED
              <select value={playback.speed} onChange={(changed) => playback.setSpeed(Number(changed.target.value))}>
                <option value="0.25">0.25×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </label>
            <button onClick={() => setFollowRed(!followRed)}>{followRed ? "FOLLOW BLUE" : "FOLLOW RED"}</button>
          </footer>
        </>
      ) : null}
    </>
  );
}
