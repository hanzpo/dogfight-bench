import { useEffect, useRef } from "react";
import { AIRFRAME_IDS, type AirframeId } from "../../sim/airframes";
import { EnergyFighterAgent } from "../../agents/baselines";
import { fox2Merge, scenarioVariant } from "../../sim/scenario";
import { DogfightSimulation } from "../../sim/simulation";
import { snapshotFromMatch, type DogfightViewer, type ViewerSnapshot } from "../../viewer";
import { ViewerCanvas } from "./ViewerCanvas";

/** Long enough to reach the merge, short enough that a quiet fight gives way to a new one. */
const MAX_SHOW_S = 75;
/** Into the fight before the first frame is drawn, so the opening shot is not two dots eight kilometres apart. */
const HEAD_START_S = 7;

function newFight(round: number, blue: AirframeId, red: AirframeId | "random"): DogfightSimulation {
  const enemy = red === "random" ? AIRFRAME_IDS[Math.floor(Math.random() * AIRFRAME_IDS.length)]! : red;
  const scenario = scenarioVariant(fox2Merge.seed + round * 7_919, fox2Merge);
  const sim = new DogfightSimulation(
    { ...scenario, airframes: { "blue-1": blue, "red-1": enemy } },
    { recordDecisions: false },
  );
  sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
  sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));
  return sim;
}

/**
 * A fight already in progress behind the menu, between the two jets picked
 * on it: two scripted pilots with missiles, filmed from behind the blue one,
 * starting over when one of them goes down or the pick changes. Anyone who
 * asks for reduced motion gets one still frame.
 */
export function AttractBackdrop({ blue, red }: { blue: AirframeId; red: AirframeId | "random" }) {
  const snapshotRef = useRef<ViewerSnapshot>(undefined);
  const viewerRef = useRef<DogfightViewer>(undefined);

  useEffect(() => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let round = Math.floor(Math.random() * 50);
    let sim = newFight(round, blue, red);
    let ended = 0;
    let last = performance.now();
    let accumulator = HEAD_START_S;
    let frame = 0;
    let shownEvents = 0;

    const tick = (now: number) => {
      accumulator += Math.min((now - last) / 1000, 0.1);
      last = now;
      let safety = 0;
      while (accumulator >= sim.config.fixedDt && safety++ < 2_000) {
        sim.step();
        accumulator -= sim.config.fixedDt;
      }
      if (sim.state.finished || sim.state.time > MAX_SHOW_S) {
        ended ||= now;
        // Hold on the ending for a moment, then cut to a new merge.
        if (now - ended > 3_000) {
          round += 1;
          sim = newFight(round, blue, red);
          ended = 0;
          accumulator = HEAD_START_S;
          shownEvents = 0;
          viewerRef.current?.setFollow("blue-1");
        }
      }
      snapshotRef.current = snapshotFromMatch(sim.state, shownEvents);
      shownEvents = sim.state.events.length;
      if (!still) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [blue, red]);

  return (
    <div className="attract" aria-hidden>
      <ViewerCanvas
        snapshotRef={snapshotRef}
        followId="blue-1"
        onReady={(viewer) => {
          viewerRef.current = viewer;
          viewer.setView("chase");
        }}
      />
    </div>
  );
}
