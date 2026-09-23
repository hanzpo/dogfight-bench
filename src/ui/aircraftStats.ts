import { AIRFRAMES, AIRFRAME_IDS, missileSpec, type AirframeId } from "../sim/airframes";
import { atmosphere } from "../sim/atmosphere";
import { bestSustainedTurn, combatMass, cornerSpeed, specificExcessPower } from "../sim/performance";

export interface AircraftStat {
  label: string;
  /** Against the rest of the roster, from 0 to 1. */
  value: number;
  /** What the bar stands for, for a screen reader and a tooltip. */
  detail: string;
}

export interface AircraftCard {
  id: AirframeId;
  name: string;
  /** What fits on a tile. */
  short: string;
  role: string;
  gun: string;
  missile: string;
  stats: AircraftStat[];
}

/**
 * The numbers the flight model flies by, turned into four bars.
 *
 * Each is measured the way the tests measure it -- turn rates at 1,500 m,
 * specific excess power at Mach 0.9 -- and set against the other seven, so
 * the bars say how a jet compares, not how it rates on some absolute scale.
 * Nothing on this card is written by hand.
 */
function measure() {
  return AIRFRAME_IDS.map((id) => {
    const frame = AIRFRAMES[id];
    const mass = combatMass(frame);
    const sustained = bestSustainedTurn(1_500, mass, frame).turnRateDegS;
    const instant = cornerSpeed(1_500, mass, frame).turnRateDegS;
    const energy = specificExcessPower(1_500, 0.9 * atmosphere(1_500).speedOfSoundMps, 1, mass, true, frame);
    const firepower = frame.gun.ratePerSecond * frame.gun.damageScale;
    return { id, frame, sustained, instant, energy, firepower, heat: frame.infrared };
  });
}

const SHORT: Partial<Record<AirframeId, string>> = { m2000c: "Mirage", jas39c: "Gripen" };

let cards: Map<AirframeId, AircraftCard> | undefined;

export function aircraftCard(id: AirframeId): AircraftCard {
  if (!cards) {
    const all = measure();
    const scale = (pick: (entry: (typeof all)[number]) => number, invert = false) => {
      const values = all.map(pick);
      const low = Math.min(...values);
      const high = Math.max(...values);
      return (entry: (typeof all)[number]) => {
        const fraction = high > low ? (pick(entry) - low) / (high - low) : 0.5;
        // Never an empty bar: the weakest jet in a category is still a fighter.
        return 0.12 + 0.88 * (invert ? 1 - fraction : fraction);
      };
    };
    const sustained = scale((entry) => entry.sustained);
    const instant = scale((entry) => entry.instant);
    const energy = scale((entry) => entry.energy);
    const firepower = scale((entry) => entry.firepower);
    const stealth = scale((entry) => entry.heat, true);
    cards = new Map(
      all.map((entry) => [
        entry.id,
        {
          id: entry.id,
          name: entry.frame.name,
          short: SHORT[entry.id] ?? entry.frame.name,
          role: entry.frame.role,
          gun: `${entry.frame.gun.name}, ${entry.frame.gun.ammunition} rounds`,
          missile: missileSpec(entry.frame.missile).name,
          stats: [
            {
              label: "Turn",
              value: (sustained(entry) + instant(entry)) / 2,
              detail: `${entry.instant.toFixed(0)}°/s first turn, ${entry.sustained.toFixed(0)}°/s sustained`,
            },
            {
              label: "Energy",
              value: energy(entry),
              detail: `${Math.round(entry.energy)} m/s of climb to spare at Mach 0.9`,
            },
            {
              label: "Guns",
              value: firepower(entry),
              detail: entry.frame.gun.name,
            },
            {
              label: "Stealth",
              value: stealth(entry),
              detail: entry.heat < 1 ? "Cooler than an F-16: harder to lock" : entry.heat > 1 ? "Hotter than an F-16: easier to lock" : "The reference",
            },
          ],
        },
      ]),
    );
  }
  return cards.get(id)!;
}
