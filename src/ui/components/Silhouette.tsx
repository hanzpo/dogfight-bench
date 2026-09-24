import type { AirframeId } from "../../sim/airframes";
import { AIRCRAFT_ICONS, AIRCRAFT_ICON_VIEWBOX } from "../aircraftIcons";

/**
 * A jet seen from above, nose up, traced from its own model: all at one
 * scale, so a Flanker is drawn bigger than an F-5 because it is. The canopy
 * is picked out, which is most of what tells one fighter from another at a
 * glance after the planform.
 */
export function Silhouette({ id, className }: { id: AirframeId; className?: string }) {
  const icon = AIRCRAFT_ICONS[id];
  return (
    <svg className={className} viewBox={AIRCRAFT_ICON_VIEWBOX} aria-hidden focusable="false">
      <path d={icon.body} />
      <path className="silhouette-canopy" d={icon.canopy} />
    </svg>
  );
}
