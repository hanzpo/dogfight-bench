import { useEffect, useRef, type RefObject } from "react";
import { Vector3 } from "three";
import { atmosphere, equivalentAirspeed } from "../../sim/atmosphere";
import { bodyAxes } from "../../sim/flight-model";
import type { MatchState } from "../../sim/types";
import type { DogfightViewer } from "../../viewer";

/**
 * The instruments a pilot actually has.
 *
 * Everything here is something the aircraft itself could tell you, laid out
 * where a fighter head-up display puts it: calibrated airspeed on the left,
 * altitude on the right, heading across the top, engine and stores along the
 * bottom. Nothing about the opponent appears here -- that is not a pilot's
 * instrument, it is the benchmark looking over their shoulder, and it lives in
 * its own plain-text panel.
 *
 * From the cockpit the pitch ladder, horizon and flight path marker are drawn
 * conformally: the ladder rung for ten degrees nose-up is projected where ten
 * degrees nose-up actually is in the world, so it lies along the real horizon
 * and banks with the aircraft. From an external view that would be a lie, so
 * the same information is shown as a compact attitude indicator instead.
 *
 * It updates by writing SVG attributes in its own frame loop. Pushing sixty
 * updates a second through React state re-renders the page every frame.
 */

const FEET = 3.28084;
const KNOTS = 1.94384;
/** How far ahead conformal symbology is projected, metres. */
const HUD_RANGE = 1_000;
/** Half-width of a pitch ladder rung, as an angle from the flight path. */
const LADDER_HALF_ANGLE = 0.13;
/** Fraction of a rung left open in the middle, so it does not cross the marker. */
const LADDER_GAP = 0.34;
/**
 * The combiner glass is about thirty degrees wide and twenty-four tall. A real
 * head-up display is a window, not a coat of paint over the whole canopy, and
 * clipping to it is most of what stops conformal symbology looking like a mess.
 */
const HUD_FIELD_DEG = { horizontal: 30, vertical: 24 };

/** Half-width of the stick-position box, in display units. */
const CONTROL_BOX_HALF = 22;

export function FlightDisplay({
  stateRef,
  viewerRef,
  followId,
  observerOpen,
}: {
  stateRef: RefObject<MatchState | undefined>;
  viewerRef: RefObject<DogfightViewer | undefined>;
  followId: string;
  observerOpen: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const conformal = useRef<SVGGElement>(null);
  const ladder = useRef<SVGGElement>(null);
  const flightPath = useRef<SVGGElement>(null);
  const adi = useRef<SVGGElement>(null);
  const adiHorizon = useRef<SVGGElement>(null);
  const speedTicks = useRef<SVGGElement>(null);
  const altTicks = useRef<SVGGElement>(null);
  const headingTicks = useRef<SVGGElement>(null);
  const text = useRef<Record<string, SVGTextElement | null>>({});
  const throttleFill = useRef<SVGRectElement>(null);
  const stickDot = useRef<SVGCircleElement>(null);
  const rudderBar = useRef<SVGRectElement>(null);
  const aoaBracket = useRef<SVGGElement>(null);
  const hudField = useRef<SVGEllipseElement>(null);
  const groups = useRef<Record<string, SVGGElement | null>>({});
  /**
   * Last content written into each generated group.
   *
   * Tapes and the ladder are built by parsing markup, which is far too
   * expensive to redo sixty times a second for a readout that changes every few
   * frames. Skipping the rebuild when the picture has not moved is most of the
   * cost of this component.
   */
  const rendered = useRef<Record<string, string>>({});
  const observer = useRef(observerOpen);
  observer.current = observerOpen;

  useEffect(() => {
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const state = stateRef.current;
      const viewer = viewerRef.current;
      const svg = root.current;
      if (!state || !viewer || !svg) return;
      const own = state.aircraft.find((aircraft) => aircraft.id === followId);
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (!own || !width || !height) return;

      layout(groups.current, width, height, observer.current);

      const axes = bodyAxes(own.orientation);
      const speed = own.velocity.length();
      const air = atmosphere(own.position.y);
      const cockpit = viewer.viewMode === "cockpit";

      const heading = compass(axes.nose);
      const track = speed > 1 ? compass(own.velocity) : heading;
      const pitchDeg = (Math.asin(clamp(axes.nose.y, -1, 1)) * 180) / Math.PI;
      const horizontalRight = axes.nose.clone().cross(UP).normalize();
      const bankDeg = (Math.atan2(axes.up.dot(horizontalRight), axes.up.y) * 180) / Math.PI;

      const set = (key: string, value: string) => {
        const node = text.current[key];
        if (node && node.textContent !== value) node.textContent = value;
      };

      // --- numbers ---------------------------------------------------------
      set("cas", String(Math.round(equivalentAirspeed(speed, own.position.y) * KNOTS)));
      set("mach", `M ${(speed / air.speedOfSoundMps).toFixed(2)}`);
      set("g", `${own.loadFactor.toFixed(1)}G`);
      set("alt", Math.round(own.position.y * FEET).toLocaleString());
      set("agl", `R ${Math.round(own.heightAboveGroundM * FEET).toLocaleString()}`);
      set("vs", `${own.velocity.y >= 0 ? "+" : ""}${Math.round(own.velocity.y * FEET * 60).toLocaleString()}`);
      set("heading", String(Math.round(heading)).padStart(3, "0"));
      set("aoa", `${((own.aoaRad * 180) / Math.PI).toFixed(1)}° AOA`);
      set("fuel", `${Math.round(own.engine.fuelKg)} KG`);
      set("ammo", String(own.ammo));
      set(
        "throttleLabel",
        own.engine.afterburner ? "AB" : own.controls.throttle > 0.02 ? `${Math.round(own.controls.throttle * 100)}%` : "IDLE",
      );
      throttleFill.current?.setAttribute("width", (Math.max(0, Math.min(1, own.controls.throttle)) * 84).toFixed(1));
      throttleFill.current?.setAttribute("fill", own.engine.afterburner ? "var(--ab)" : "currentColor");

      // --- control position -------------------------------------------------
      // Driven by what the aircraft is being commanded to do rather than by the
      // device in the pilot's hand, so it reads the same whether a person, an
      // autopilot or a model is flying -- which is what makes it worth showing.
      stickDot.current?.setAttribute("cx", (clamp(own.controls.roll, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
      stickDot.current?.setAttribute("cy", (-clamp(own.controls.pitch, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
      const rudder = clamp(own.controls.yaw, -1, 1) * CONTROL_BOX_HALF;
      rudderBar.current?.setAttribute("x", Math.min(0, rudder).toFixed(1));
      rudderBar.current?.setAttribute("width", Math.abs(rudder).toFixed(1));

      // --- moving tapes ----------------------------------------------------
      renderTape(
        speedTicks.current,
        rendered.current,
        "speed",
        equivalentAirspeed(speed, own.position.y) * KNOTS,
        20,
        100,
        height,
        false,
      );
      renderTape(altTicks.current, rendered.current, "alt", own.position.y * FEET, 500, 2_000, height, true);
      renderHeadingTape(headingTicks.current, rendered.current, heading, width);

      // --- attitude --------------------------------------------------------
      if (cockpit) {
        conformal.current?.setAttribute("visibility", "visible");
        sizeHudField(hudField.current, viewer, width, height);
        adi.current?.setAttribute("visibility", "hidden");
        drawLadder(ladder.current, rendered.current, own.position, axes.nose, viewer, width, height);

        // Flight path marker: where the aircraft is actually going, which is
        // not where the nose points whenever there is any angle of attack.
        if (speed > 1) {
          const marker = viewer.project(own.position.clone().addScaledVector(own.velocity.clone().normalize(), HUD_RANGE));
          if (!marker.behind) {
            flightPath.current?.setAttribute("visibility", "visible");
            flightPath.current?.setAttribute(
              "transform",
              `translate(${(marker.x * width).toFixed(1)} ${(marker.y * height).toFixed(1)})`,
            );
            // The AoA bracket sits beside the marker, as it does on the real jet.
            aoaBracket.current?.setAttribute("visibility", own.flcs.limiterActive ? "visible" : "hidden");
          } else {
            flightPath.current?.setAttribute("visibility", "hidden");
            aoaBracket.current?.setAttribute("visibility", "hidden");
          }
        }
      } else {
        conformal.current?.setAttribute("visibility", "hidden");
        adi.current?.setAttribute("visibility", "visible");
        // Compact attitude indicator: the horizon rolls and slides behind a
        // fixed aircraft symbol, the way an artificial horizon does.
        adiHorizon.current?.setAttribute(
          "transform",
          `rotate(${(-bankDeg).toFixed(1)}) translate(0 ${(clamp(pitchDeg, -90, 90) * 0.95).toFixed(1)})`,
        );
        set("adiPitch", `${pitchDeg >= 0 ? "+" : ""}${Math.round(pitchDeg)}°`);
        set("adiBank", `${Math.abs(Math.round(bankDeg))}°${bankDeg >= 0 ? "R" : "L"}`);
        set("track", `TRK ${String(Math.round(track)).padStart(3, "0")}`);
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [stateRef, viewerRef, followId]);

  const label = (key: string) => (node: SVGTextElement | null) => {
    text.current[key] = node;
  };

  const group = (key: string) => (node: SVGGElement | null) => {
    groups.current[key] = node;
  };

  return (
    <svg ref={root} className={`flight-display${observerOpen ? " with-observer" : ""}`} aria-hidden>
      {/* ---------- conformal head-up symbology (cockpit only) ---------- */}
      <defs>
        <clipPath id="hud-field">
          <ellipse ref={hudField} rx="240" ry="150" />
        </clipPath>
      </defs>
      <g ref={conformal} className="conformal" clipPath="url(#hud-field)" visibility="hidden">
        <g ref={ladder} />
        <g ref={flightPath} className="fpm" visibility="hidden">
          <circle r="9" />
          <line x1="-19" y1="0" x2="-9" y2="0" />
          <line x1="9" y1="0" x2="19" y2="0" />
          <line x1="0" y1="-9" x2="0" y2="-17" />
          <g ref={aoaBracket} className="aoa-bracket" visibility="hidden">
            <path d="M -30 -9 L -36 -9 L -36 9 L -30 9" />
          </g>
        </g>
      </g>

      {/* ---------- attitude indicator (external views) ---------- */}
      <g ref={setBoth(adi, group("adi"))} className="adi" visibility="hidden">
        <clipPath id="adi-clip">
          <circle r="52" />
        </clipPath>
        <circle className="adi-face" r="52" />
        <g clipPath="url(#adi-clip)">
          <g ref={adiHorizon}>
            <rect className="adi-sky" x="-150" y="-150" width="300" height="150" />
            <rect className="adi-ground" x="-150" y="0" width="300" height="150" />
            <line className="adi-horizon" x1="-150" y1="0" x2="150" y2="0" />
            {[-30, -20, -10, 10, 20, 30].map((pitch) => (
              <line
                key={pitch}
                className="adi-rung"
                x1={Math.abs(pitch) === 10 ? -14 : -9}
                y1={-pitch * 0.95}
                x2={Math.abs(pitch) === 10 ? 14 : 9}
                y2={-pitch * 0.95}
              />
            ))}
          </g>
        </g>
        <path className="adi-symbol" d="M -24 0 L -9 0 M 9 0 L 24 0 M 0 -3 L 0 3" />
        <path className="adi-pointer" d="M 0 -52 L -5 -44 L 5 -44 Z" />
        <circle className="adi-bezel" r="52" />
        <text ref={label("adiPitch")} className="adi-readout" x="-52" y="68">
          +0°
        </text>
        <text ref={label("adiBank")} className="adi-readout" x="52" y="68" textAnchor="end">
          0°R
        </text>
        <text ref={label("track")} className="adi-readout" y="82" textAnchor="middle">
          TRK 000
        </text>
      </g>

      {/* ---------- airspeed, left ---------- */}
      <g ref={group("speed")} className="tape-group speed-group">
        <g ref={speedTicks} className="tape-ticks" />
        <g ref={group("speedReadout")}>
        <g className="tape-box">
          <path d="M 0 -13 L 58 -13 L 58 13 L 0 13 L -8 0 Z" />
          <text ref={label("cas")} x="50" y="5" textAnchor="end">
            0
          </text>
        </g>
        <text className="tape-caption" x="0" y="-26">
          KCAS
        </text>
        <text ref={label("mach")} className="tape-sub" x="0" y="42">
          M 0.00
        </text>
        <text ref={label("g")} className="tape-sub" x="0" y="58">
          1.0G
        </text>
        <text ref={label("aoa")} className="tape-sub" x="0" y="74">
          0.0° AOA
        </text>
        </g>
      </g>

      {/* ---------- altitude, right ---------- */}
      <g ref={group("alt")} className="tape-group alt-group">
        <g ref={altTicks} className="tape-ticks" />
        <g ref={group("altReadout")}>
        <g className="tape-box">
          <path d="M 0 -13 L -72 -13 L -72 13 L 0 13 L 8 0 Z" />
          <text ref={label("alt")} x="-8" y="5" textAnchor="end">
            0
          </text>
        </g>
        <text className="tape-caption" y="-26" textAnchor="end">
          FEET
        </text>
        <text ref={label("vs")} className="tape-sub" y="42" textAnchor="end">
          +0
        </text>
        <text ref={label("agl")} className="tape-sub" y="58" textAnchor="end">
          R 0
        </text>
        </g>
      </g>

      {/* ---------- heading, top ---------- */}
      <g ref={group("heading")} className="heading-group">
        <g ref={headingTicks} className="tape-ticks" />
        <path className="heading-caret" d="M 0 4 L -6 13 L 6 13 Z" />
        <g className="tape-box">
          <rect x="-25" y="-19" width="50" height="22" />
          <text ref={label("heading")} y="-3" textAnchor="middle">
            000
          </text>
        </g>
      </g>

      {/* ---------- engine and stores, bottom ---------- */}
      <g ref={group("engine")} className="engine-group">
        <text className="tape-caption" y="-8">
          THROTTLE
        </text>
        <rect className="throttle-track" x="0" y="0" width="84" height="8" />
        <rect ref={throttleFill} className="throttle-fill" x="0" y="0" width="0" height="8" />
        <g className="control-indicator" transform="translate(126 -20)">
          <rect
            className="control-box"
            x={-CONTROL_BOX_HALF}
            y={-CONTROL_BOX_HALF}
            width={CONTROL_BOX_HALF * 2}
            height={CONTROL_BOX_HALF * 2}
          />
          <line className="control-cross" x1={-CONTROL_BOX_HALF} y1="0" x2={CONTROL_BOX_HALF} y2="0" />
          <line className="control-cross" x1="0" y1={-CONTROL_BOX_HALF} x2="0" y2={CONTROL_BOX_HALF} />
          <circle ref={stickDot} className="control-dot" cx="0" cy="0" r="3.2" />
          <rect ref={rudderBar} className="control-rudder" x="0" y={CONTROL_BOX_HALF + 5} width="0" height="4" />
        </g>
        <text ref={label("throttleLabel")} className="tape-sub" x="92" y="8">
          IDLE
        </text>
        <text ref={label("fuel")} className="tape-sub" y="26">
          0 KG
        </text>
      </g>

      <g ref={group("stores")} className="stores-group">
        <text className="tape-caption" y="-8" textAnchor="end">
          GUN
        </text>
        <text ref={label("ammo")} className="stores-value" y="14" textAnchor="end">
          511
        </text>
      </g>
    </svg>
  );
}

const UP = new Vector3(0, 1, 0);

/** Lets one element feed two refs. */
function setBoth<T>(a: { current: T | null }, b: (node: T | null) => void) {
  return (node: T | null) => {
    a.current = node;
    b(node);
  };
}

/**
 * Positions every instrument group from the measured viewport.
 *
 * Done here rather than in CSS because percentage transforms on SVG elements
 * are not portable between browser engines.
 */
function layout(
  groups: Record<string, SVGGElement | null>,
  width: number,
  height: number,
  observerOpen: boolean,
): void {
  const margin = Math.min(Math.max(width * 0.05, 26), 92);
  // The observer panel owns the right edge when it is open, so the altitude
  // tape and stores move inboard of it rather than hiding underneath.
  const rightEdge = width - (observerOpen ? 300 : margin);
  const place = (key: string, x: number, y: number) =>
    groups[key]?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);

  place("speed", margin, 0);
  place("speedReadout", 0, height / 2);
  place("alt", rightEdge, 0);
  place("altReadout", 0, height / 2);
  place("heading", width / 2, 86);
  place("engine", margin, height - 96);
  place("stores", rightEdge, height - 96);
  place("adi", Math.min(Math.max(width * 0.15, 196), 280), height / 2);
}

/** Sizes the clip region to the combiner's field of view for this camera. */
function sizeHudField(
  ellipse: SVGEllipseElement | null,
  viewer: DogfightViewer,
  width: number,
  height: number,
): void {
  if (!ellipse) return;
  const verticalHalf = (viewer.camera.fov * Math.PI) / 360;
  const rx =
    (Math.tan((HUD_FIELD_DEG.horizontal * Math.PI) / 360) /
      (Math.tan(verticalHalf) * viewer.camera.aspect)) *
    (width / 2);
  const ry = (Math.tan((HUD_FIELD_DEG.vertical * Math.PI) / 360) / Math.tan(verticalHalf)) * (height / 2);
  ellipse.setAttribute("cx", (width / 2).toFixed(1));
  ellipse.setAttribute("cy", (height / 2).toFixed(1));
  ellipse.setAttribute("rx", rx.toFixed(1));
  ellipse.setAttribute("ry", ry.toFixed(1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Compass bearing of a world direction. +z is south, so north is -z. */
function compass(direction: Vector3): number {
  return (((Math.atan2(direction.x, -direction.z) * 180) / Math.PI) + 360) % 360;
}

/**
 * Swaps a group's contents only when they actually changed.
 *
 * Every renderer keeps its own slot. They used to share one, which meant none
 * of them ever got a cache hit and all three re-parsed their markup on every
 * animation frame.
 */
function setMarkup(group: SVGGElement, cache: Record<string, string>, key: string, markup: string): void {
  const slot = `${key}:markup`;
  if (cache[slot] === markup) return;
  cache[slot] = markup;
  group.innerHTML = markup;
}

/**
 * Draws a vertical tape: ticks that slide past a fixed box, so rate of change
 * is visible as motion rather than only as a changing number.
 */
function renderTape(
  group: SVGGElement | null,
  cache: Record<string, string>,
  key: string,
  value: number,
  step: number,
  span: number,
  height: number,
  right: boolean,
): void {
  if (!group) return;
  // Ticks only move in whole pixels; rebuilding for smaller changes is waste.
  const signature = `${Math.round(value)}|${Math.round(height)}`;
  if (cache[key] === signature) return;
  cache[key] = signature;
  const centre = height / 2;
  const pixelsPerUnit = (height * 0.62) / span;
  const first = Math.ceil((value - span / 2) / step) * step;
  const marks: string[] = [];
  for (let tick = first; tick <= value + span / 2; tick += step) {
    const y = centre - (tick - value) * pixelsPerUnit;
    const major = tick % (step * 5) === 0;
    const length = major ? 15 : 8;
    marks.push(
      right
        ? `<line x1="0" y1="${y.toFixed(1)}" x2="${-length}" y2="${y.toFixed(1)}" />`
        : `<line x1="0" y1="${y.toFixed(1)}" x2="${length}" y2="${y.toFixed(1)}" />`,
    );
    if (major) {
      marks.push(
        `<text x="${right ? -20 : 20}" y="${(y + 4).toFixed(1)}" text-anchor="${right ? "end" : "start"}">${Math.round(tick)}</text>`,
      );
    }
  }
  setMarkup(group, cache, key, marks.join(""));
}

function renderHeadingTape(
  group: SVGGElement | null,
  cache: Record<string, string>,
  heading: number,
  width: number,
): void {
  if (!group) return;
  const signature = `${heading.toFixed(1)}|${Math.round(width)}`;
  if (cache["heading"] === signature) return;
  cache["heading"] = signature;
  // The group this draws into is already translated to the top centre of the
  // viewport, so every mark is placed relative to that origin. Adding half the
  // width here as well -- which is what this used to do -- pushes the entire
  // tape a further half-screen right, off the edge of the display.
  const pixelsPerDegree = Math.min(width * 0.32, 420) / 60;
  const marks: string[] = [];
  for (let offset = -35; offset <= 35; offset += 5) {
    const bearing = (Math.round(heading / 5) * 5 + offset + 360) % 360;
    const delta = ((bearing - heading + 540) % 360) - 180;
    if (Math.abs(delta) > 32) continue;
    const x = delta * pixelsPerDegree;
    const major = bearing % 10 === 0;
    marks.push(`<line x1="${x.toFixed(1)}" y1="14" x2="${x.toFixed(1)}" y2="${major ? 26 : 21}" />`);
    if (major) {
      marks.push(
        `<text x="${x.toFixed(1)}" y="41" text-anchor="middle">${String(bearing / 10).padStart(2, "0")}</text>`,
      );
    }
  }
  setMarkup(group, cache, "heading", marks.join(""));
}

/**
 * Conformal pitch ladder.
 *
 * Each rung is placed in the world at its own pitch angle and projected, so it
 * lands on the real horizon, banks with the aircraft and compresses toward the
 * vanishing point without any of that being faked in screen space.
 */
function drawLadder(
  group: SVGGElement | null,
  cache: Record<string, string>,
  position: Vector3,
  nose: Vector3,
  viewer: DogfightViewer,
  width: number,
  height: number,
): void {
  if (!group) return;
  const level = new Vector3(nose.x, 0, nose.z);
  if (level.lengthSq() < 1e-6) return;
  level.normalize();
  const right = level.clone().cross(UP).normalize();
  const half = Math.tan(LADDER_HALF_ANGLE) * HUD_RANGE;
  const marks: string[] = [];

  for (let pitch = -60; pitch <= 60; pitch += 5) {
    const radians = (pitch * Math.PI) / 180;
    const centre = position
      .clone()
      .addScaledVector(level, Math.cos(radians) * HUD_RANGE)
      .addScaledVector(UP, Math.sin(radians) * HUD_RANGE);
    const scale = pitch === 0 ? 1.8 : 1;

    // Each rung is two segments with a gap in the middle, so the flight path
    // marker is never drawn through.
    const offsets: Array<[number, number]> = [
      [-half * scale, -half * scale * LADDER_GAP],
      [half * scale * LADDER_GAP, half * scale],
    ];
    const ends = offsets.map(
      ([from, to]) =>
        [
          viewer.project(centre.clone().addScaledVector(right, from)),
          viewer.project(centre.clone().addScaledVector(right, to)),
        ] as const,
    );
    if (ends.some((segment) => segment[0].behind || segment[1].behind)) continue;

    const dashed = pitch < 0 ? ' stroke-dasharray="9 7"' : "";
    for (const segment of ends) {
      const x1 = segment[0].x * width;
      const y1 = segment[0].y * height;
      const x2 = segment[1].x * width;
      const y2 = segment[1].y * height;
      if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
      marks.push(
        `<line class="${pitch === 0 ? "horizon" : "rung"}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${dashed} />`,
      );
    }

    if (pitch !== 0 && pitch % 10 === 0) {
      const outer = ends[1]![1];
      const inner = ends[1]![0];
      const x = outer.x * width;
      const y = outer.y * height;
      const angle = (Math.atan2(y - inner.y * height, x - inner.x * width) * 180) / Math.PI;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        marks.push(
          `<text class="rung-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="start" transform="rotate(${angle.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" dy="4" dx="6">${Math.abs(pitch)}</text>`,
        );
      }
    }
  }
  setMarkup(group, cache, "ladder", marks.join(""));
}
