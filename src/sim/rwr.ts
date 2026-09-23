import { Vector3 } from "three";
import { RWR } from "./config";
import { airframe, missileSpec } from "./airframes";
import { bodyAxes } from "./flight-model";
import type { AircraftState, MatchState } from "./types";
import { clamp, degrees } from "../math";

/**
 * What the threat warning gear in the cockpit says.
 *
 * Two different sensors, shown on one scope the way the pilot sees them. The
 * radar warning receiver hears the bandit's fire-control radar, which only
 * reaches us when we are inside its scan; it goes from search to track as the
 * range closes. A heat-seeker emits nothing, so the missile is seen by the
 * approach warner instead, which picks up the motor plume and then the body.
 */
export interface RwrContact {
  kind: "radar" | "missile";
  sourceId: string;
  /** Relative to our nose: positive right, so 90 is the right wingtip and 180 dead astern. */
  bearingDeg: number;
  elevationDeg: number;
  rangeM: number;
  level: "search" | "track" | "missile";
  /** Seconds to impact at the present closure, for a missile. */
  timeToGoS?: number;
}

function relative(own: AircraftState, point: Vector3): { bearingDeg: number; elevationDeg: number; rangeM: number } {
  const axes = bodyAxes(own.orientation);
  const delta = point.clone().sub(own.position);
  const x = delta.dot(axes.right);
  const y = delta.dot(axes.up);
  const z = delta.dot(axes.nose);
  return {
    bearingDeg: degrees(Math.atan2(x, z)),
    elevationDeg: degrees(Math.atan2(y, Math.hypot(x, z))),
    rangeM: delta.length(),
  };
}

export function rwrContacts(state: MatchState, ownId: string): RwrContact[] {
  const own = state.aircraft.find((aircraft) => aircraft.id === ownId);
  if (!own?.alive) return [];
  const contacts: RwrContact[] = [];

  for (const emitter of state.aircraft) {
    if (!emitter.alive || emitter.id === own.id || emitter.team === own.team) continue;
    const toUs = own.position.clone().sub(emitter.position);
    const range = toUs.length();
    if (range > RWR.radarRangeM) continue;
    const offNose = Math.acos(clamp(bodyAxes(emitter.orientation).nose.dot(toUs.normalize()), -1, 1));
    if (offNose > RWR.radarScanHalfAngleRad) continue;
    contacts.push({
      kind: "radar",
      sourceId: emitter.id,
      ...relative(own, emitter.position),
      level: range <= RWR.radarTrackRangeM ? "track" : "search",
    });
  }

  for (const missile of state.missiles) {
    const shooter = state.aircraft.find((aircraft) => aircraft.id === missile.ownerId);
    if (missile.ownerId === own.id || shooter?.team === own.team) continue;
    const toUs = own.position.clone().sub(missile.position);
    const range = toUs.length();
    if (range > RWR.missileWarningRangeM) continue;
    // A plume is bright enough to see anywhere inside the warner's reach; a
    // coasting body only once it is close.
    if (missile.motorRemainingS <= 0 && range > RWR.missileWarningRangeM * 0.4) continue;
    const closure = missile.velocity.clone().sub(own.velocity).dot(toUs.normalize());
    if (closure <= 0) continue;
    contacts.push({
      kind: "missile",
      sourceId: `missile-${missile.id}`,
      ...relative(own, missile.position),
      level: "missile",
      timeToGoS: range / closure,
    });
  }
  return contacts;
}

/**
 * Where a shot is worth taking, as a rough launch zone.
 *
 * Not a fly-out: a missile's reach depends on how fast the two are closing
 * and how thin the air is, and this says so in one line. It was set against
 * shots at a jet flying straight, which is the most any launch zone promises.
 */
export function missileLaunchZone(own: AircraftState, target: AircraftState): { minM: number; maxM: number } {
  const spec = missileSpec(airframe(own.airframe).missile);
  const lineOfSight = target.position.clone().sub(own.position).normalize();
  const closure = own.velocity.clone().sub(target.velocity).dot(lineOfSight);
  const altitudeFactor = clamp(0.7 + own.position.y / 20_000, 0.7, 1.3);
  const maxM = clamp((5_500 + closure * 4) * altitudeFactor * spec.rangeFactor, 1_500, 12_000);
  const headOn = closure > own.velocity.length();
  return { minM: headOn ? 1_000 : 500, maxM };
}
