import { AIRFRAME_IDS, type AirframeId } from "../../sim/airframes";
import { aircraftCard } from "../aircraftStats";
import { Silhouette } from "./Silhouette";

/**
 * The hangar: every jet as a tile, and what the chosen one is good at.
 *
 * The tiles are radio buttons underneath, so a keyboard moves through them
 * with the arrow keys and a screen reader hears one choice among eight.
 */
export function AircraftPicker({ value, onChange }: { value: AirframeId; onChange: (id: AirframeId) => void }) {
  const chosen = aircraftCard(value);
  return (
    <fieldset className="hangar">
      <legend>Aircraft</legend>
      <div className="hangar-grid">
        {AIRFRAME_IDS.map((id) => {
          const card = aircraftCard(id);
          return (
            <label key={id} className="hangar-tile">
              <input
                type="radio"
                name="aircraft"
                value={id}
                checked={id === value}
                onChange={() => onChange(id)}
              />
              <span className="hangar-face">
                <Silhouette id={id} className="hangar-silhouette" />
                <span className="hangar-name" aria-hidden>
                  {card.short}
                </span>
                <span className="visually-hidden">{card.name}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div className="hangar-detail" aria-live="polite">
        <div className="hangar-detail-head">
          <span className="hangar-role">
            {chosen.name} <span className="hangar-role-kind">· {chosen.role}</span>
          </span>
          <span className="hangar-arms">
            {chosen.gun} · {chosen.missile}
          </span>
        </div>
        <dl className="hangar-stats">
          {chosen.stats.map((stat) => (
            <div key={stat.label} title={stat.detail}>
              <dt>{stat.label}</dt>
              <dd>
                <span className="hangar-bar" aria-hidden>
                  <span style={{ width: `${Math.round(stat.value * 100)}%` }} />
                </span>
                <span className="visually-hidden">
                  {Math.round(stat.value * 10)} out of 10. {stat.detail}.
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </fieldset>
  );
}
