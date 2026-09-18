import { neutralMerge } from "../../sim/scenario";
import { observationFor } from "../../sim/telemetry";
import type { MatchState } from "../../sim/types";

/**
 * What the benchmark knows and the pilot does not.
 *
 * Angle off the bandit's tail, their fuel and damage, the energy ledger between
 * the two aircraft, the predicted miss distance: none of this is on an
 * instrument in any cockpit. It is the perfect-information view the agents are
 * handed, so it is deliberately presented as data -- one plain monospace block
 * in one place, with none of the head-up display's styling -- rather than
 * dressed up as something the pilot is reading.
 *
 * Keeping the two apart is the whole point. Mixing them produces a display that
 * looks like a cockpit and lies about what a cockpit contains.
 */
export function ObserverPanel({
  state,
  followId,
  open,
  onToggle,
}: {
  state: MatchState | undefined;
  followId: string;
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
  const aspect =
    relative.angleOffTailDeg < 70 ? "behind them" : relative.angleOffTailDeg > 120 ? "in front of them" : "abeam";

  if (!open) {
    return (
      <aside className="observer collapsed">
        <button className="observer-toggle" onClick={onToggle}>
          OBSERVER
        </button>
      </aside>
    );
  }

  return (
    <aside className="observer">
      <button className="observer-toggle" onClick={onToggle}>
        ×
      </button>
      <header>
        <span>OBSERVER</span>
        <span className="observer-note">perfect information · not visible to the pilot</span>
      </header>

      <Section title="ENGAGEMENT">
        <Row label="clock" value={clock} />
        <Row label="range" value={formatRange(relative.rangeM)} />
        <Row label="closure" value={`${signed(Math.round(relative.closureRateMps))} m/s`} />
        <Row label="angle off tail" value={`${Math.round(relative.angleOffTailDeg)}°`} note={aspect} />
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

      <Section title="DAMAGE">
        <Row label="own hull" value={`${Math.round(own.health * 100)}%`} note={`${own.hitsTaken} hits`} tone={own.health < 0.7 ? "bad" : undefined} />
        <Row label="bandit hull" value={`${Math.round(bandit.health * 100)}%`} note={`${bandit.hitsTaken} hits`} tone={bandit.health < 0.7 ? "good" : undefined} />
        <Row label="bandit ammo" value={String(bandit.ammoRemaining)} />
        <Row label="bandit fuel" value={`${Math.round(bandit.fuelKg)} kg`} />
      </Section>
    </aside>
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
        {note ? <span className="observer-sub"> {note}</span> : null}
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
