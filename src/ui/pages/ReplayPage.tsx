import { useEffect, useRef, useState } from "react";
import { FolderOpen, Pause, Play } from "@phosphor-icons/react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, ServerUnavailableError } from "../api";
import { FlightDisplay } from "../components/FlightDisplay";
import { DetailsPanel } from "../components/DetailsPanel";
import { TacticalOverlay } from "../components/TacticalOverlay";
import { ViewerCanvas } from "../components/ViewerCanvas";
import { useReplayPlayback } from "../hooks/useReplayPlayback";
import type { DogfightViewer, ViewMode } from "../../viewer";
import { parseReplay, type ReplayFile } from "../../sim/replay";

export function ReplayPage() {
  const { id } = useParams();
  const location = useLocation();
  const [replay, setReplay] = useState<ReplayFile>();
  const [error, setError] = useState<string>();
  const [followRed, setFollowRed] = useState(false);
  const [view, setView] = useState<ViewMode>("chase");
  const [detailsOpen, setDetailsOpen] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<DogfightViewer>(undefined);
  const playback = useReplayPlayback(replay);
  const followId = followRed ? "red-1" : "blue-1";

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

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
          <FlightDisplay
            stateRef={playback.stateRef}
            viewerRef={viewer}
            followId={followId}
            detailsOpen={detailsOpen}
          />
          <TacticalOverlay stateRef={playback.stateRef} viewerRef={viewer} followId={followId} />
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
            <button onClick={() => fileInput.current?.click()}>
              <FolderOpen />
              Open a file
            </button>
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
            <div className="control-group">
            <button
              className="icon"
              aria-label={playback.playing ? "Pause" : "Play"}
              title={playback.playing ? "Pause" : "Play"}
              onClick={() => playback.setPlaying(!playback.playing)}
            >
              {playback.playing ? <Pause weight="fill" /> : <Play weight="fill" />}
            </button>
            <input
              className="scrubber"
              type="range"
              aria-label="Position in the replay"
              min={0}
              max={playback.duration}
              step={0.05}
              value={playback.time}
              style={{ "--played": `${playback.duration ? (playback.time / playback.duration) * 100 : 0}%` } as React.CSSProperties}
              onChange={(changed) => {
                playback.setPlaying(false);
                playback.setTime(Number(changed.target.value));
              }}
            />
            <span className="timecode">
              {playback.time.toFixed(1)} / {playback.duration.toFixed(1)}s
            </span>
            </div>

            <div className="control-group">
            <label>
              View
              <select id="view" value={view} onChange={(changed) => setView(changed.target.value as ViewMode)}>
<option value="chase">Chase</option>
                <option value="track">Target track</option>
                <option value="arena">Arena</option>
                <option value="cockpit">Cockpit</option>
                <option value="free">Free look</option>
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
            <label>
              Camera
              <div className="segmented" role="group" aria-label="Which aircraft the camera follows">
                <button aria-pressed={!followRed} onClick={() => setFollowRed(false)}>
                  Blue
                </button>
                <button aria-pressed={followRed} onClick={() => setFollowRed(true)}>
                  Red
                </button>
              </div>
            </label>
            </div>
          </footer>
        </>
      ) : null}
    </>
  );
}
