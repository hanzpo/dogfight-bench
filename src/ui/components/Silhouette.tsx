import { AIRFRAMES, airframe, type AirframeId } from "../../sim/airframes";

/** One scale for every jet, so a Su-27 is drawn bigger than an F-5 because it is. */
const EXTENT = Math.max(...Object.values(AIRFRAMES).map((frame) => Math.max(frame.geometry.wingSpanM, frame.geometry.lengthM))) / 2;

/**
 * A jet seen from above, drawn from the same numbers as its placeholder
 * model: fuselage, wing planform, tailplanes and canards, to scale, nose up.
 * The planforms are what tell a delta from a swept wing at a glance.
 */
export function Silhouette({ id, className }: { id: AirframeId; className?: string }) {
  const frame = airframe(id);
  const shape = frame.placeholder;
  const length = frame.geometry.lengthM;
  const half = length / 2;
  const radius = shape.fuselageRadiusM;
  const span = frame.geometry.wingSpanM;
  // SVG y runs down, so "along the nose" is negative y.
  const y = (along: number) => -along;

  const semiSpan = span / 2 - radius * 0.8;
  const rootLeading = half - shape.wingRootAt * length;
  const tipLeading = rootLeading - Math.tan((shape.wingSweepDeg * Math.PI) / 180) * semiSpan;
  const wing = (side: 1 | -1) =>
    [
      [side * radius * 0.8, rootLeading],
      [side * (radius * 0.8 + semiSpan), tipLeading],
      [side * (radius * 0.8 + semiSpan), tipLeading - shape.wingTipChordM],
      [side * radius * 0.8, rootLeading - shape.wingRootChordM],
    ]
      .map(([x, along]) => `${x!.toFixed(2)},${y(along!).toFixed(2)}`)
      .join(" ");

  const tailSpan = span * 0.3;
  const tailLead = -half + length * 0.2;
  const tail = (side: 1 | -1) =>
    [
      [side * radius * 0.7, tailLead],
      [side * (radius * 0.7 + tailSpan), tailLead - tailSpan * 0.7],
      [side * (radius * 0.7 + tailSpan), tailLead - tailSpan * 0.7 - 0.8],
      [side * radius * 0.7, tailLead - 2.2],
    ]
      .map(([x, along]) => `${x!.toFixed(2)},${y(along!).toFixed(2)}`)
      .join(" ");

  const canardLead = frame.cockpitEye[2] - 1.0;
  const canard = (side: 1 | -1) =>
    [
      [side * radius * 0.85, canardLead],
      [side * (radius * 0.85 + 1.3), canardLead - 1.1],
      [side * (radius * 0.85 + 1.3), canardLead - 1.5],
      [side * radius * 0.85, canardLead - 1.4],
    ]
      .map(([x, along]) => `${x!.toFixed(2)},${y(along!).toFixed(2)}`)
      .join(" ");

  // Fuselage: a pointed nose that widens to full radius, then straight to the tail.
  const nose = y(half);
  const shoulder = y(half - length * 0.22);
  const tailEnd = y(-half);
  const fuselage = `M 0 ${nose} C ${radius * 0.5} ${nose + length * 0.08}, ${radius} ${shoulder - length * 0.04}, ${radius} ${shoulder} L ${radius * 0.85} ${tailEnd} L ${-radius * 0.85} ${tailEnd} L ${-radius} ${shoulder} C ${-radius} ${shoulder - length * 0.04}, ${-radius * 0.5} ${nose + length * 0.08}, 0 ${nose} Z`;

  const extent = EXTENT;
  return (
    <svg
      className={className}
      viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
      aria-hidden
      focusable="false"
    >
      <polygon points={wing(1)} />
      <polygon points={wing(-1)} />
      {shape.tailplane ? (
        <>
          <polygon points={tail(1)} />
          <polygon points={tail(-1)} />
        </>
      ) : null}
      {shape.canards ? (
        <>
          <polygon points={canard(1)} />
          <polygon points={canard(-1)} />
        </>
      ) : null}
      <path d={fuselage} />
    </svg>
  );
}
