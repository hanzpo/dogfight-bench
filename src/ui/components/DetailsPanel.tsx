import { CaretLeft, X } from "@phosphor-icons/react";
import { neutralMerge } from "../../sim/scenario";
import type { DecisionRecord } from "../../sim/simulation";
import { observationFor } from "../../sim/telemetry";
import type { MatchState } from "../../sim/types";
import { aspect } from "../../format";

export function DetailsPanel({
  state,
  followId,
  decision,
  open,
  onToggle,
}: {
  state: MatchState | undefined;
  followId: string;
  decision?: DecisionRecord | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  if (!state) return null;
  const followed = state.aircraft.find((aircraft) => aircraft.id === followId) ?? state.aircraft[0];
  if (!followed) return null;

  const observation = observationFor(state, followed.id, neutralMerge, 0);
  const own = observation.aircraft.find((aircraft) => aircraft.id === followed.id)!;
  const bandit = observation.aircraft.find((aircraft) => aircraft.id !== followed.id)!;
  const relative = observation.relative;
  const gun = relative.gunSolution;

  const clock = `${String(Math.floor(state.time / 60)).padStart(2, "0")}:${(state.time % 60).toFixed(1).padStart(4, "0")}`;

  if (!open) {
    return (
      <aside className="details collapsed">
        <button className="details-toggle" onClick={onToggle} aria-label="Show details" title="Show details">
          <CaretLeft weight="bold" />
          DETAILS
        </button>
      </aside>
    );
  }

  return (
    <aside className="details">
      <button className="details-toggle icon" onClick={onToggle} aria-label="Hide details" title="Hide details">
        <X weight="bold" />
      </button>
      <header>
        <span>DETAILS</span>
        <span className="details-note">perfect information · not visible to the pilot</span>
      </header>

      {decision ? <DecisionSection decision={decision} /> : null}

      <Section title="ENGAGEMENT">
        <Row label="clock" value={clock} />
        <Row label="range" value={formatRange(relative.rangeM)} />
        <Row label="closure" value={`${signed(Math.round(relative.closureRateMps))} m/s`} />
        <Row label="angle off tail" value={`${Math.round(relative.angleOffTailDeg)}°`} note={aspect(relative.angleOffTailDeg)} />
        <Row label="LOS rate" value={`${relative.lineOfSightRateDegS.toFixed(1)} °/s`} />
      </Section>

      <Section title="ENERGY">
        <Row
          label="advantage"
          value={`${signed(Math.round(relative.energyAdvantageM))} m`}
          tone={relative.energyAdvantageM >= 0 ? "good" : "bad"}
        />
        <Row label="specific energy" value={`${Math.round(own.specificEnergyM)} m`} note={`bandit ${Math.round(bandit.specificEnergyM)}`} />
        <Row label="Ps" value={`${signed(Math.round(own.specificExcessPowerMps))} m/s`} tone={own.specificExcessPowerMps < 0 ? "bad" : "good"} />
        <Row label="corner speed" value={`${Math.round(own.cornerSpeedMps)} m/s`} note={`now ${Math.round(own.speedMps)}`} />
        <Row label="g available" value={`${own.availableLoadFactorG.toFixed(1)}`} note={`${own.sustainedLoadFactorG.toFixed(1)} sustained`} />
      </Section>

      <Section title="GUN SOLUTION">
        <Row
          label="predicted miss"
          value={gun.predictedMissM > 999 ? "—" : `${Math.round(gun.predictedMissM)} m`}
          tone={gun.trackingSolution ? "good" : undefined}
        />
        <Row label="time of flight" value={`${gun.timeOfFlightS.toFixed(2)} s`} />
        <Row label="rounds lethal" value={gun.inLethalRange ? "yes" : "no"} tone={gun.inLethalRange ? undefined : "bad"} />
        <Row label="threatened" value={relative.threatened ? "YES" : "no"} tone={relative.threatened ? "bad" : undefined} />
      </Section>

      <Section title="TERRAIN">
        <Row
          label="ground below"
          value={own.terrain.overWater ? "water" : `${Math.round(own.terrain.groundElevationM)} m`}
          note={`${Math.round(own.terrain.clearanceM)} m clear`}
        />
        <Row
          label="clearance ahead"
          value={`${Math.round(own.terrain.minimumClearanceAheadM)} m`}
          note={
            own.terrain.timeToImpactS === null
              ? `in ${own.terrain.timeToMinimumClearanceS.toFixed(0)}s`
              : `impact in ${own.terrain.timeToImpactS.toFixed(0)}s`
          }
          tone={own.terrain.minimumClearanceAheadM < own.terrain.clearanceM ? "bad" : undefined}
        />
        <Row
          label="recovery margin"
          value={`${Math.round(own.terrain.recoveryMarginM)} m`}
          note={`pull costs ${Math.round(own.terrain.recoveryHeightLossM)} m`}
          tone={own.terrain.recoveryMarginM <= 0 ? "bad" : undefined}
        />
        <Row
          label="warning"
          value={own.terrain.warning.toUpperCase()}
          tone={own.terrain.warning === "pull-up" ? "bad" : own.terrain.warning === "clear" ? "good" : undefined}
        />
      </Section>

      <Section title="DAMAGE">
        <Row label="own hull" value={`${Math.round(own.health * 100)}%`} note={`${own.hitsTaken} hits`} tone={own.health < 0.7 ? "bad" : undefined} />
        <Row label="bandit hull" value={`${Math.round(bandit.health * 100)}%`} note={`${bandit.hitsTaken} hits`} tone={bandit.health < 0.7 ? "good" : undefined} />
        <Row label="bandit ammo" value={String(bandit.ammoRemaining)} />
        <Row label="bandit fuel" value={`${Math.round(bandit.fuelKg)} kg`} />
      </Section>
    </aside>
  );
}

function DecisionSection({ decision }: { decision: DecisionRecord }) {
  const action = decision.action;
  return (
    <section>
      <h2>MODEL</h2>
      <dl>
        <Row label="latency" value={`${Math.round(decision.latencyMs)} ms`} />
        <Row label="command" value={action.maneuver} note={`${action.targetG.toFixed(0)} g · ${action.throttle}`} />
        {decision.usage?.costUsd ? (
          <Row label="cost" value={`$${decision.usage.costUsd.toFixed(5)}`} />
        ) : null}
        {decision.error ? <Row label="error" value={decision.error} tone="bad" /> : null}
      </dl>
      {decision.rationale ? <p className="details-rationale">{decision.rationale}</p> : null}

      {decision.distributions?.map((distribution) => (
        <div className="distribution" key={distribution.question}>
          <div className="distribution-head">
            <span>{distribution.question.replace(/_/g, " ")}</span>
            <span className="details-sub">conf {(distribution.confidence * 100).toFixed(0)}%</span>
          </div>
          {distribution.options.slice(0, 6).map((option) => (
            <div
              className={`distribution-row${option.id === distribution.choice ? " chosen" : ""}`}
              key={option.id}
            >
              <span className="distribution-label">{option.id.replace(/_/g, " ")}</span>
              <span className="distribution-bar">
                <span style={{ width: `${(option.probability * 100).toFixed(1)}%` }} />
              </span>
              <span className="distribution-value">{(option.probability * 100).toFixed(0)}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      <dl>{children}</dl>
    </section>
  );
}

function Row({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "bad" }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={tone ?? ""}>
        {value}
        {note ? <span className="details-sub"> {note}</span> : null}
      </dd>
    </>
  );
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}

function formatRange(metres: number): string {
  return metres >= 1_000 ? `${(metres / 1_000).toFixed(2)} km` : `${Math.round(metres)} m`;
}
