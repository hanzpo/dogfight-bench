import type { MatchState } from "../../sim/types";
import { observationFor } from "../../sim/telemetry";
import { neutralMerge } from "../../sim/scenario";

const KNOTS = 1.94384;
const FEET = 3.28084;

/**
 * Flight and tactical readout for the followed aircraft.
 *
 * It shows the same quantities the agents are given -- energy, sustainable g,
 * gun solution -- so a person watching can see what the model saw.
 */
export function Hud({ state, followId }: { state: MatchState | undefined; followId: string }) {
  if (!state) return null;
  const followed = state.aircraft.find((aircraft) => aircraft.id === followId) ?? state.aircraft[0];
  if (!followed) return null;

  const observation = observationFor(state, followed.id, neutralMerge, 0);
  const own = observation.aircraft.find((aircraft) => aircraft.id === followed.id)!;
  const relative = observation.relative;
  const clock = `${String(Math.floor(state.time / 60)).padStart(2, "0")}:${(state.time % 60).toFixed(1).padStart(4, "0")}`;

  return (
    <div className="hud">
      <div className="hud-panel hud-left">
        <Row label="CLOCK" value={clock} />
        <Row label="SPEED" value={`${Math.round(own.speedMps * KNOTS)} KT`} sub={`M ${own.mach.toFixed(2)}`} />
        <Row label="ALT" value={`${Math.round(own.altitudeM * FEET).toLocaleString()} FT`} sub={`AGL ${Math.round(own.altitudeAglM * FEET).toLocaleString()}`} />
        <Row label="G" value={own.loadFactorG.toFixed(1)} sub={`${own.sustainedLoadFactorG.toFixed(1)} sustained`} warn={own.limiterActive} />
        <Row label="Ps" value={`${own.specificExcessPowerMps >= 0 ? "+" : ""}${own.specificExcessPowerMps.toFixed(0)} M/S`} warn={own.specificExcessPowerMps < 0} />
        <Row label="AMMO" value={String(own.ammoRemaining)} sub={`${Math.round(own.fuelKg)} KG FUEL`} />
        <Row label="INTEGRITY" value={`${Math.round(own.health * 100)}%`} warn={own.health < 0.7} />
      </div>

      <div className="hud-panel hud-right">
        <Row label="RANGE" value={`${Math.round(relative.rangeM).toLocaleString()} M`} sub={`${relative.closureRateMps >= 0 ? "+" : ""}${Math.round(relative.closureRateMps)} M/S`} />
        <Row label="AOT" value={`${Math.round(relative.angleOffTailDeg)}°`} sub={relative.angleOffTailDeg < 60 ? "BEHIND THEM" : relative.angleOffTailDeg > 120 ? "IN FRONT" : "ABEAM"} />
        <Row label="ENERGY" value={`${relative.energyAdvantageM >= 0 ? "+" : ""}${Math.round(relative.energyAdvantageM)} M`} warn={relative.energyAdvantageM < 0} />
        <Row
          label="GUNS"
          value={relative.gunSolution.predictedMissM > 999 ? "NO SOLUTION" : `${Math.round(relative.gunSolution.predictedMissM)} M MISS`}
          sub={`TOF ${relative.gunSolution.timeOfFlightS.toFixed(2)}S`}
          good={relative.gunSolution.trackingSolution}
        />
        {relative.threatened ? <div className="hud-alert">THREATENED</div> : null}
        {own.departed ? <div className="hud-alert">DEPARTED</div> : null}
      </div>
    </div>
  );
}

function Row({ label, value, sub, warn, good }: { label: string; value: string; sub?: string; warn?: boolean; good?: boolean }) {
  return (
    <div className={`hud-row${warn ? " warn" : ""}${good ? " good" : ""}`}>
      <span className="hud-label">{label}</span>
      <span className="hud-value">{value}</span>
      {sub ? <span className="hud-sub">{sub}</span> : null}
    </div>
  );
}
