import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "@phosphor-icons/react";
import type { ReplayFile } from "../../sim/replay";
import type { DogfightViewer, ViewMode } from "../../viewer";
import { useReplayPlayback } from "../hooks/useReplayPlayback";
import { FlightDisplay } from "./FlightDisplay";
import { TacticalOverlay } from "./TacticalOverlay";
import { ViewerCanvas } from "./ViewerCanvas";

const SPEEDS = [0.25, 0.5, 1] as const;
const SEEK_S = 5;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/**
 * The fight just flown, played back in place.
 *
 * Space plays and pauses, the arrow keys step five seconds, V changes the
 * camera, F swaps which jet it follows and Esc goes back.
 */
export function InstantReplay({
  replay,
  startAt,
  views,
  initialView,
  onExit,
  exitLabel,
}: {
  replay: ReplayFile;
  startAt: number;
  views: ReadonlyArray<{ value: ViewMode; label: string }>;
  initialView: ViewMode;
  onExit: () => void;
  exitLabel: string;
}) {
  const playback = useReplayPlayback(replay, startAt);
  const viewer = useRef<DogfightViewer>(undefined);
  const [view, setView] = useState<ViewMode>(initialView);
  const [followEnemy, setFollowEnemy] = useState(false);
  const followId = followEnemy ? "red-1" : "blue-1";
  // Focus starts on play, so Space does what it says there rather than
  // pressing whatever else happened to be focused.
  const play = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    viewer.current?.setView(view);
  }, [view]);

  useEffect(() => {
    play.current?.focus();
  }, []);

  const { setPlaying, playing, setTime, time, duration, setSpeed } = playback;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement && event.target.type === "range" && /Arrow/.test(event.code)) return;
      if (event.code === "Escape") {
        event.preventDefault();
        onExit();
      } else if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        setPlaying(!playing);
      } else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setTime(Math.min(duration, Math.max(0, time + (event.code === "ArrowLeft" ? -SEEK_S : SEEK_S))));
      } else if (event.code === "KeyV") {
        setView((current) => views[(views.findIndex((entry) => entry.value === current) + 1) % views.length]!.value);
      } else if (event.code === "KeyF") {
        setFollowEnemy((current) => !current);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onExit, setPlaying, playing, setTime, time, duration, views]);

  const viewLabel = views.find((entry) => entry.value === view)?.label ?? "";

  return (
    <div className="instant-replay">
      <ViewerCanvas
        snapshotRef={playback.snapshotRef}
        followId={followId}
        onReady={(instance) => {
          viewer.current = instance;
          instance.setView(view);
        }}
      />
      <FlightDisplay stateRef={playback.stateRef} viewerRef={viewer} followId={followId} detailsOpen={false} />
      <TacticalOverlay stateRef={playback.stateRef} viewerRef={viewer} followId={followId} />

      <div className="replay-badge" role="status">
        <span className="replay-dot" aria-hidden />
        Replay
      </div>

      <div key={view} className="view-toast" role="status">
        {viewLabel}
      </div>

      <div className="replay-bar" role="group" aria-label="Replay controls">
        <button
          ref={play}
          className="replay-play"
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause weight="fill" aria-hidden /> : <Play weight="fill" aria-hidden />}
        </button>
        <input
          className="scrubber"
          type="range"
          aria-label="Position in the replay"
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
          min={0}
          max={duration}
          step={0.05}
          value={time}
          style={{ "--played": `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
          onChange={(changed) => {
            setPlaying(false);
            setTime(Number(changed.target.value));
          }}
        />
        <span className="replay-time" aria-hidden>
          {clock(time)} / {clock(duration)}
        </span>
        <div className="replay-speed" role="group" aria-label="Speed">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              aria-pressed={playback.speed === speed}
              onClick={() => setSpeed(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>
        <button className="replay-follow" onClick={() => setFollowEnemy(!followEnemy)} aria-pressed={followEnemy}>
          {followEnemy ? "Following enemy" : "Following you"}
        </button>
        <button className="primary replay-exit" onClick={onExit}>
          {exitLabel}
        </button>
      </div>
    </div>
  );
}
