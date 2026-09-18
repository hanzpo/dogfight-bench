import { neutralMerge } from "../../sim/scenario";
import { observationFor } from "../../sim/telemetry";
import type { MatchState } from "../../sim/types";

const KNOTS = 1.94384;
const FEET = 3.28084;

/**
 * Flight and tactical readout for the followed aircraft.
 *
 * Laid out the way a head-up display is -- speed on the left, altitude on the
 * right, the fight in between -- because the point is to be readable at a
 * glance while something is happening, not to list every field. It shows the
 * same quantities the agents are given, so a person watching can see what the
 * model saw and judge whether its decision was reasonable.
 */
export function Hud({ state, followId }: { state: MatchState | undefined; followId: string }) {
  if (!state) return null;
  const followed = state.aircraft.find((aircraft) => aircraft.id === followId) ?? state.aircraft[0];
  if (!followed) return null;

  const observation = observationFor(state, followed.id, neutralMerge, 0);
  const own = observation.aircraft.find((aircraft) => aircraft.id === followed.id)!;
  const bandit = observation.aircraft.find((aircraft) => aircraft.id !== followed.id)!;
  const relative = observation.relative;

  const clock = `${String(Math.floor(state.time / 60)).padStart(2, "0")}:${(state.time % 60).toFixed(1).padStart(4, "0")}`;
  // Where this jet sits between "cannot turn" and "turn radius too big".
  const cornerRatio = own.speedMps / Math.max(own.cornerSpeedMps, 1);
  const energyShare = clampUnit(0.5 + relative.energyAdvantageM / 6_000);

  return (
    <div className={`hud${followId.startsWith("red") ? " hud-red" : ""}`}>
      <div className="hud-corner hud-tl">
        <Tape
          label="SPEED"
          value={Math.round(own.speedMps * KNOTS).toLocaleString()}
          unit="KT"
          note={`M ${own.mach.toFixed(2)}`}
          fill={clampUnit(own.speedMps / 520)}
          marker={clampUnit(own.cornerSpeedMps / 520)}
          state={cornerRatio < 0.85 ? "warn" : cornerRatio > 1.5 ? "caution" : "good"}
          hint={cornerRatio < 0.85 ? "SLOW" : cornerRatio > 1.5 ? "FAST" : "CORNER"}
        />
        <Readout label="G" value={own.loadFactorG.toFixed(1)} note={`${own.sustainedLoadFactorG.toFixed(1)} SUS`} state={own.limiterActive ? "caution" : undefined} />
        <Readout
          label="Ps"
          value={`${own.specificExcessPowerMps >= 0 ? "+" : ""}${Math.round(own.specificExcessPowerMps)}`}
          note="M/S"
          state={own.specificExcessPowerMps < -40 ? "warn" : own.specificExcessPowerMps > 0 ? "good" : undefined}
        />
      </div>

      <div className="hud-corner hud-tr">
        <Tape
          label="ALT"
          value={Math.round(own.altitudeM * FEET).toLocaleString()}
          unit="FT"
          note={`AGL ${Math.round(own.altitudeAglM * FEET).toLocaleString()}`}
          fill={clampUnit(own.altitudeM / 12_000)}
          state={own.altitudeAglM < 600 ? "warn" : undefined}
          hint={own.altitudeAglM < 600 ? "PULL UP" : undefined}
          align="right"
        />
        <Readout label="RANGE" value={formatRange(relative.rangeM)} note={`${relative.closureRateMps >= 0 ? "+" : ""}${Math.round(relative.closureRateMps)} M/S`} align="right" />
        <Readout
          label="AOT"
          value={`${Math.round(relative.angleOffTailDeg)}°`}
          note={relative.angleOffTailDeg < 70 ? "BEHIND THEM" : relative.angleOffTailDeg > 120 ? "THEY'RE AHEAD" : "ABEAM"}
          state={relative.angleOffTailDeg < 70 ? "good" : undefined}
          align="right"
        />
      </div>

      <div className="hud-bottom">
        <div className="energy-bar" title="Specific energy advantage">
          <span className="energy-label">ENERGY</span>
          <div className="energy-track">
            <div className="energy-fill" style={{ left: `${(Math.min(energyShare, 0.5) * 100).toFixed(1)}%`, width: `${(Math.abs(energyShare - 0.5) * 100).toFixed(1)}%` }} />
            <div className="energy-centre" />
          </div>
          <span className={`energy-value${relative.energyAdvantageM < 0 ? " warn" : " good"}`}>
            {relative.energyAdvantageM >= 0 ? "+" : ""}
            {Math.round(relative.energyAdvantageM)} M
          </span>
        </div>

        <div className="ammo-row">
          <Pill label="AMMO" value={String(own.ammoRemaining)} state={own.ammoRemaining === 0 ? "warn" : undefined} />
          <Pill label="FUEL" value={`${Math.round(own.fuelKg)} KG`} state={own.fuelKg < 300 ? "caution" : undefined} />
          <Pill label="HULL" value={`${Math.round(own.health * 100)}%`} state={own.health < 0.7 ? "warn" : undefined} />
          <Pill label="BANDIT" value={`${Math.round(bandit.health * 100)}%`} state={bandit.health < 0.7 ? "good" : undefined} />
          <Pill label="CLOCK" value={clock} />
        </div>
      </div>

      <div className="hud-alerts">
        {relative.threatened ? <div className="alert critical">THREAT · BREAK</div> : null}
        {own.departed ? <div className="alert critical">DEPARTED</div> : null}
        {own.altitudeAglM < 600 ? <div className="alert critical">TERRAIN</div> : null}
        {own.limiterActive ? <div className="alert">ALPHA LIMIT</div> : null}
        {own.ammoRemaining === 0 ? <div className="alert">WINCHESTER</div> : null}
      </div>
    </div>
  );
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatRange(metres: number): string {
  return metres >= 1_000 ? `${(metres / 1_000).toFixed(1)} KM` : `${Math.round(metres)} M`;
}

type Tone = "good" | "warn" | "caution" | undefined;

function Tape({
  label,
  value,
  unit,
  note,
  fill,
  marker,
  state,
  hint,
  align,
}: {
  label: string;
  value: string;
  unit: string;
  note?: string;
  fill: number;
  marker?: number;
  state?: Tone;
  hint?: string;
  align?: "right";
}) {
  return (
    <div className={`tape${align === "right" ? " right" : ""}${state ? ` ${state}` : ""}`}>
      <div className="tape-head">
        <span className="tape-label">{label}</span>
        {hint ? <span className="tape-hint">{hint}</span> : null}
      </div>
      <div className="tape-value">
        {value}
        <span className="tape-unit">{unit}</span>
      </div>
      <div className="tape-track">
        <div className="tape-fill" style={{ height: `${(fill * 100).toFixed(1)}%` }} />
        {marker !== undefined ? <div className="tape-marker" style={{ bottom: `${(marker * 100).toFixed(1)}%` }} /> : null}
      </div>
      {note ? <div className="tape-note">{note}</div> : null}
    </div>
  );
}

function Readout({
  label,
  value,
  note,
  state,
  align,
}: {
  label: string;
  value: string;
  note?: string;
  state?: Tone;
  align?: "right";
}) {
  return (
    <div className={`readout${align === "right" ? " right" : ""}${state ? ` ${state}` : ""}`}>
      <span className="readout-label">{label}</span>
      <span className="readout-value">{value}</span>
      {note ? <span className="readout-note">{note}</span> : null}
    </div>
  );
}

function Pill({ label, value, state }: { label: string; value: string; state?: Tone }) {
  return (
    <div className={`pill${state ? ` ${state}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
