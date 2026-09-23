import { useEffect, useRef, type RefObject } from "react";
import { Vector3 } from "three";
import { atmosphere, equivalentAirspeed } from "../../sim/atmosphere";
import { bodyAxes } from "../../sim/flight-model";
import { rwrContacts, type RwrContact } from "../../sim/rwr";
import { airframe, missileSpec } from "../../sim/airframes";
import type { MatchState } from "../../sim/types";
import type { DogfightViewer } from "../../viewer";
import { clamp, degrees, radians } from "../../math";
import { signedCount } from "../../format";

const FEET = 3.28084;
const KNOTS = 1.94384;
const HUD_RANGE = 1_000;
const LADDER_HALF_ANGLE = 0.13;
const LADDER_GAP = 0.34;
const HUD_FIELD_DEG = { horizontal: 30, vertical: 24 };

const CONTROL_BOX_HALF = 22;
const RWR_RADIUS = 32;
const BINGO_KG = 450;

/**
 * The head-up display, laid out as one: airspeed and altitude either side of
 * the middle, heading beneath, weapons and engine in the lower corners of the
 * same box -- where a pilot's eye already is, not pinned to the edges of the
 * window. One colour, thin strokes, no panels behind anything.
 *
 * `showControls` adds a stick-and-throttle readout, for the lab, where seeing
 * what the input is doing is the point.
 */
export function FlightDisplay({
  stateRef,
  viewerRef,
  followId,
  detailsOpen,
  showControls = false,
}: {
  stateRef: RefObject<MatchState | undefined>;
  viewerRef: RefObject<DogfightViewer | undefined>;
  followId: string;
  detailsOpen: boolean;
  showControls?: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const conformal = useRef<SVGGElement>(null);
  const ladder = useRef<SVGGElement>(null);
  const flightPath = useRef<SVGGElement>(null);
  const speedTicks = useRef<SVGGElement>(null);
  const altTicks = useRef<SVGGElement>(null);
  const headingTicks = useRef<SVGGElement>(null);
  const text = useRef<Record<string, SVGTextElement | null>>({});
  const throttleFill = useRef<SVGRectElement>(null);
  const stickDot = useRef<SVGCircleElement>(null);
  const rudderBar = useRef<SVGRectElement>(null);
  const aoaBracket = useRef<SVGGElement>(null);
  const hudField = useRef<SVGEllipseElement>(null);
  const rwrContactsGroup = useRef<SVGGElement>(null);
  const missileWarning = useRef<SVGGElement>(null);
  const groups = useRef<Record<string, SVGGElement | null>>({});
  const rendered = useRef<Record<string, string>>({});
  const details = useRef(detailsOpen);
  details.current = detailsOpen;

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

      const box = layout(groups.current, width, height, details.current);

      const axes = bodyAxes(own.orientation);
      const speed = own.velocity.length();
      const air = atmosphere(own.position.y);
      const cockpit = viewer.viewMode === "cockpit";
      const heading = compass(axes.nose);

      const set = (key: string, value: string) => {
        const node = text.current[key];
        if (node && node.textContent !== value) node.textContent = value;
      };

      const knots = equivalentAirspeed(speed, own.position.y) * KNOTS;
      set("cas", String(Math.round(knots)));
      set("mach", `M ${(speed / air.speedOfSoundMps).toFixed(2)}`);
      set("g", `G ${own.loadFactor.toFixed(1)}`);
      set("aoa", `AOA ${degrees(own.aoaRad).toFixed(1)}`);
      set("alt", Math.round(own.position.y * FEET).toLocaleString());
      set("agl", `R ${Math.round(own.heightAboveGroundM * FEET).toLocaleString()}`);
      set("vs", signedCount(own.velocity.y * FEET * 60));
      set("heading", String(Math.round(heading)).padStart(3, "0"));
      set("throttleLabel", throttleLabel(own.engine.afterburner, own.controls.throttle));
      const fuel = Math.round(own.engine.fuelKg);
      set("fuel", fuel < BINGO_KG ? `BINGO ${fuel}` : `FUEL ${fuel.toLocaleString()}`);
      text.current["fuel"]?.setAttribute("class", fuel < BINGO_KG ? "hud-sub hud-caution" : "hud-sub");

      const frameSpec = airframe(own.airframe);
      set("ammo", `GUN ${own.ammo}`);
      const armed = own.stores.missileStations > 0;
      // Removed rather than hidden: a hidden SVG group still takes up room.
      groups.current["srm"]?.setAttribute("display", armed ? "inline" : "none");
      groups.current["rwr"]?.setAttribute("display", armed ? "inline" : "none");
      if (armed) {
        const tone = own.stores.missiles > 0 ? SEEKER_LABEL[own.seeker.tone] : "";
        set("missiles", `${missileSpec(frameSpec.missile).name.toUpperCase()} ${own.stores.missiles}${tone ? ` ${tone}` : ""}`);
        set("flares", `FLR ${own.stores.flares}`);
        const contacts = rwrContacts(state, own.id);
        drawRwr(rwrContactsGroup.current, rendered.current, contacts);
        const inbound = contacts
          .filter((contact) => contact.kind === "missile")
          .sort((a, b) => (a.timeToGoS ?? Infinity) - (b.timeToGoS ?? Infinity))[0];
        missileWarning.current?.setAttribute("visibility", inbound ? "visible" : "hidden");
        if (inbound) {
          set(
            "warning",
            `MISSILE ${clock(inbound.bearingDeg)} O'CLOCK  ${(inbound.rangeM / 1_000).toFixed(1)} KM`,
          );
        }
      } else {
        missileWarning.current?.setAttribute("visibility", "hidden");
      }

      if (showControls) {
        const filled = clamp(own.controls.throttle, 0, 1) * CONTROL_BOX_HALF * 2;
        throttleFill.current?.setAttribute("y", (CONTROL_BOX_HALF - filled).toFixed(1));
        throttleFill.current?.setAttribute("height", filled.toFixed(1));
        stickDot.current?.setAttribute("cx", (clamp(own.controls.roll, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
        stickDot.current?.setAttribute("cy", (-clamp(own.controls.pitch, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
        const rudder = clamp(own.controls.yaw, -1, 1) * CONTROL_BOX_HALF;
        rudderBar.current?.setAttribute("x", Math.min(0, rudder).toFixed(1));
        rudderBar.current?.setAttribute("width", Math.abs(rudder).toFixed(1));
      }

      renderTape(speedTicks.current, rendered.current, "speed", knots, 10, 100, box.halfHeight * 0.8, -1);
      renderTape(altTicks.current, rendered.current, "alt", own.position.y * FEET, 100, 1_000, box.halfHeight * 0.8, 1);
      renderHeadingTape(headingTicks.current, rendered.current, heading, box.halfWidth * 0.6);

      if (cockpit) {
        conformal.current?.setAttribute("visibility", "visible");
        sizeHudField(hudField.current, viewer, width, height);
        drawLadder(ladder.current, rendered.current, own.position, axes.nose, viewer, width, height);

        if (speed > 1) {
          const marker = viewer.project(own.position.clone().addScaledVector(own.velocity.clone().normalize(), HUD_RANGE));
          // "inherit", never "visible": in SVG a child marked visible shows
          // through a hidden parent, so leaving the cockpit left the marker
          // frozen on screen where it last was.
          if (!marker.behind) {
            flightPath.current?.setAttribute("visibility", "inherit");
            flightPath.current?.setAttribute(
              "transform",
              `translate(${(marker.x * width).toFixed(1)} ${(marker.y * height).toFixed(1)})`,
            );
            aoaBracket.current?.setAttribute("visibility", own.flcs.limiterActive ? "inherit" : "hidden");
          } else {
            flightPath.current?.setAttribute("visibility", "hidden");
            aoaBracket.current?.setAttribute("visibility", "hidden");
          }
        }
      } else {
        conformal.current?.setAttribute("visibility", "hidden");
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [stateRef, viewerRef, followId, showControls]);

  const label = (key: string) => (node: SVGTextElement | null) => {
    text.current[key] = node;
  };

  const group = (key: string) => (node: SVGGElement | null) => {
    groups.current[key] = node;
  };

  return (
    <svg ref={root} className={`flight-display${detailsOpen ? " with-details" : ""}`} aria-hidden>
      <defs>
        <clipPath id="hud-field">
          <ellipse ref={hudField} rx="240" ry="150" />
        </clipPath>
      </defs>
      <g ref={conformal} className="conformal" clipPath="url(#hud-field)" visibility="hidden">
        <g ref={ladder} />
        <g ref={flightPath} className="fpm" visibility="hidden">
          <circle r="7" />
          <line x1="-17" y1="0" x2="-7" y2="0" />
          <line x1="7" y1="0" x2="17" y2="0" />
          <line x1="0" y1="-7" x2="0" y2="-14" />
          <g ref={aoaBracket} className="aoa-bracket" visibility="hidden">
            <path d="M -26 -8 L -31 -8 L -31 8 L -26 8" />
          </g>
        </g>
      </g>

      <g ref={group("speed")} className="tape-group speed-group">
        <g ref={speedTicks} className="tape-ticks" />
        <g className="tape-box">
          <rect x="-58" y="-11" width="58" height="22" />
          <text ref={label("cas")} x="-6" y="5" textAnchor="end">
            0
          </text>
        </g>
        <text ref={label("mach")} className="hud-sub" x="0" y="30" textAnchor="end">
          M 0.00
        </text>
        <text ref={label("g")} className="hud-sub" x="0" y="45" textAnchor="end">
          G 1.0
        </text>
        <text ref={label("aoa")} className="hud-sub" x="0" y="60" textAnchor="end">
          0.0
        </text>
      </g>

      <g ref={group("alt")} className="tape-group alt-group">
        <g ref={altTicks} className="tape-ticks" />
        <g className="tape-box">
          <rect x="0" y="-11" width="66" height="22" />
          <text ref={label("alt")} x="60" y="5" textAnchor="end">
            0
          </text>
        </g>
        <text ref={label("agl")} className="hud-sub" x="0" y="30">
          R 0
        </text>
        <text ref={label("vs")} className="hud-sub" x="0" y="45">
          +0
        </text>
      </g>

      <g ref={group("heading")} className="heading-group">
        <g ref={headingTicks} className="tape-ticks" />
        <path className="heading-caret" d="M -4 9 L 0 3 L 4 9" />
        <g className="tape-box">
          <rect x="-22" y="12" width="44" height="20" />
          <text ref={label("heading")} y="27" textAnchor="middle">
            000
          </text>
        </g>
      </g>

      <g ref={group("stores")} className="stores-group">
        <text ref={label("ammo")} className="hud-sub">
          GUN 511
        </text>
        <g ref={group("srm")} display="none">
          <text ref={label("missiles")} className="hud-sub" y="15">
            AIM-9M 2
          </text>
          <text ref={label("flares")} className="hud-sub" y="30">
            FLR 30
          </text>
        </g>
      </g>

      <g ref={group("engine")} className="engine-group">
        <text ref={label("throttleLabel")} className="hud-sub" textAnchor="end">
          THR 85
        </text>
        <text ref={label("fuel")} className="hud-sub" y="15" textAnchor="end">
          FUEL 0
        </text>
      </g>

      {showControls ? (
        <g ref={group("controls")} className="control-indicator">
          <rect className="throttle-track" x="-60" y={-CONTROL_BOX_HALF} width="8" height={CONTROL_BOX_HALF * 2} />
          <rect ref={throttleFill} className="throttle-fill" x="-60" y={CONTROL_BOX_HALF} width="8" height="0" />
          <rect
            className="control-box"
            x={-CONTROL_BOX_HALF}
            y={-CONTROL_BOX_HALF}
            width={CONTROL_BOX_HALF * 2}
            height={CONTROL_BOX_HALF * 2}
          />
          <line className="control-cross" x1={-CONTROL_BOX_HALF} y1="0" x2={CONTROL_BOX_HALF} y2="0" />
          <line className="control-cross" x1="0" y1={-CONTROL_BOX_HALF} x2="0" y2={CONTROL_BOX_HALF} />
          <circle ref={stickDot} className="control-dot" cx="0" cy="0" r="3" />
          <rect ref={rudderBar} className="control-rudder" x="0" y={CONTROL_BOX_HALF + 5} width="0" height="3" />
        </g>
      ) : null}

      <g ref={group("rwr")} className="rwr" display="none">
        <circle className="rwr-scope" r={RWR_RADIUS} />
        <circle className="rwr-ring" r={RWR_RADIUS / 2} />
        <path className="rwr-ownship" d="M 0 -4 L 0 4 M -4 1 L 4 1" />
        <g ref={rwrContactsGroup} />
      </g>

      <g ref={group("warning")}>
        <g ref={missileWarning} className="missile-warning" visibility="hidden">
          <text ref={label("warning")} className="missile-warning-title" textAnchor="middle">
            MISSILE
          </text>
        </g>
      </g>
    </svg>
  );
}

const UP = new Vector3(0, 1, 0);

const SEEKER_LABEL = { off: "", search: "", growl: "TONE", lock: "LOCK" } as const;

function clock(bearingDeg: number): number {
  const hour = Math.round((((bearingDeg % 360) + 360) % 360) / 30) % 12;
  return hour === 0 ? 12 : hour;
}

/**
 * The threat scope: our nose at the top, each emitter at its bearing. A radar
 * sits on the outer ring and moves in when it goes from search to track; a
 * missile sits inside, where the eye goes first.
 */
function drawRwr(group: SVGGElement | null, cache: Record<string, string>, contacts: RwrContact[]): void {
  if (!group) return;
  const marks = contacts.map((contact) => {
    const radius =
      contact.kind === "missile" ? RWR_RADIUS * 0.36 : contact.level === "track" ? RWR_RADIUS * 0.64 : RWR_RADIUS * 0.86;
    const angle = (contact.bearingDeg * Math.PI) / 180;
    const x = (Math.sin(angle) * radius).toFixed(1);
    const y = (-Math.cos(angle) * radius).toFixed(1);
    if (contact.kind === "missile") {
      return `<g class="rwr-missile" transform="translate(${x} ${y})"><text y="3.5" text-anchor="middle">M</text></g>`;
    }
    const box = contact.level === "track" ? `<path class="rwr-track" d="M 0 -8 L 8 0 L 0 8 L -8 0 Z" />` : "";
    return `<g class="rwr-radar" transform="translate(${x} ${y})">${box}<text y="3.5" text-anchor="middle">16</text></g>`;
  });
  setMarkup(group, cache, "rwr", marks.join(""));
}

function throttleLabel(afterburner: boolean, throttle: number): string {
  if (afterburner) return "AB";
  if (throttle <= 0.02) return "IDLE";
  return `THR ${Math.round(throttle * 100)}`;
}

/**
 * Where everything goes, as one head-up box around the middle of the window.
 * Returns the box's half-width and half-height for the tapes to size to.
 */
function layout(
  groups: Record<string, SVGGElement | null>,
  width: number,
  height: number,
  detailsOpen: boolean,
): { halfWidth: number; halfHeight: number } {
  // The details panel takes the right edge; the box moves over for it.
  const usable = detailsOpen ? width - 300 : width;
  // Above the lab's control bar where there is one; it wraps, so it is measured.
  const bar = document.querySelector(".controls")?.getBoundingClientRect().top;
  const floor = bar !== undefined && bar > height * 0.5 ? bar : height;
  const cx = usable / 2;
  let cy = height / 2;
  const halfWidth = clamp(usable * 0.2, 190, 320);
  // The weapons and engine lines hang 40 px below the box's bottom edge:
  // shrink the box to keep them clear of the floor, and move it up if that
  // is not enough.
  const room = floor - 44 - cy;
  const halfHeight = clamp(Math.min(height * 0.3, room), 110, 250);
  if (cy + halfHeight + 44 > floor) cy = floor - 44 - halfHeight;
  const place = (key: string, x: number, y: number) =>
    groups[key]?.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);

  place("speed", cx - halfWidth, cy);
  place("alt", cx + halfWidth, cy);
  place("heading", cx, cy + halfHeight);
  place("stores", cx - halfWidth - 58, cy + halfHeight - 6);
  place("engine", cx + halfWidth + 66, cy + halfHeight - 6);
  place("warning", cx, cy - halfHeight + 4);
  const margin = clamp(width * 0.03, 20, 40);
  place("rwr", margin + RWR_RADIUS, floor - margin - RWR_RADIUS);
  place("controls", margin + 2 * RWR_RADIUS + 90, floor - margin - 30);
  return { halfWidth, halfHeight };
}

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

function compass(direction: Vector3): number {
  return (((Math.atan2(direction.x, -direction.z) * 180) / Math.PI) + 360) % 360;
}

function setMarkup(group: SVGGElement, cache: Record<string, string>, key: string, markup: string): void {
  const slot = `${key}:markup`;
  if (cache[slot] === markup) return;
  cache[slot] = markup;
  group.innerHTML = markup;
}

/**
 * A vertical scale beside a readout box, centred on the current value.
 * `side` is -1 to hang it off the left of the box, 1 off the right.
 */
function renderTape(
  group: SVGGElement | null,
  cache: Record<string, string>,
  key: string,
  value: number,
  step: number,
  span: number,
  halfHeight: number,
  side: -1 | 1,
): void {
  if (!group) return;
  const signature = `${Math.round(value)}|${Math.round(halfHeight)}`;
  if (cache[key] === signature) return;
  cache[key] = signature;
  const pixelsPerUnit = halfHeight / (span / 2);
  // Measured from the box's outer edge, which is 58 px out on the left and 66 on the right.
  const edge = side < 0 ? -64 : 72;
  const first = Math.ceil((value - span / 2) / step) * step;
  const marks: string[] = [];
  for (let tick = first; tick <= value + span / 2; tick += step) {
    const y = -(tick - value) * pixelsPerUnit;
    const major = tick % (step * 5) === 0;
    const length = major ? 9 : 5;
    marks.push(`<line x1="${edge}" y1="${y.toFixed(1)}" x2="${edge + side * length}" y2="${y.toFixed(1)}" />`);
    // Labels stay clear of the box they would otherwise be written across.
    if (major && Math.abs(y) > 18) {
      marks.push(
        `<text x="${edge + side * 13}" y="${(y + 4).toFixed(1)}" text-anchor="${side < 0 ? "end" : "start"}">${Math.round(tick)}</text>`,
      );
    }
  }
  setMarkup(group, cache, key, marks.join(""));
}

/** The heading scale, laid flat along the bottom of the box. */
function renderHeadingTape(
  group: SVGGElement | null,
  cache: Record<string, string>,
  heading: number,
  halfWidth: number,
): void {
  if (!group) return;
  const signature = `${heading.toFixed(1)}|${Math.round(halfWidth)}`;
  if (cache["heading"] === signature) return;
  cache["heading"] = signature;
  const pixelsPerDegree = halfWidth / 30;
  const marks: string[] = [];
  for (let offset = -35; offset <= 35; offset += 5) {
    const bearing = (Math.round(heading / 5) * 5 + offset + 360) % 360;
    const delta = ((bearing - heading + 540) % 360) - 180;
    if (Math.abs(delta) > 30) continue;
    const x = delta * pixelsPerDegree;
    const major = bearing % 10 === 0;
    marks.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${major ? -8 : -4}" />`);
    if (major) {
      marks.push(`<text x="${x.toFixed(1)}" y="-12" text-anchor="middle">${String(bearing / 10).padStart(2, "0")}</text>`);
    }
  }
  setMarkup(group, cache, "heading", marks.join(""));
}

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
    const angle = radians(pitch);
    const centre = position
      .clone()
      .addScaledVector(level, Math.cos(angle) * HUD_RANGE)
      .addScaledVector(UP, Math.sin(angle) * HUD_RANGE);
    const scale = pitch === 0 ? 1.8 : 1;

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
      let angle = (Math.atan2(y - inner.y * height, x - inner.x * width) * 180) / Math.PI;
      let anchor = "start";
      let dx = 6;
      if (angle > 90 || angle < -90) {
        angle -= Math.sign(angle) * 180;
        anchor = "end";
        dx = -6;
      }
      if (Number.isFinite(x) && Number.isFinite(y)) {
        marks.push(
          `<text class="rung-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" transform="rotate(${angle.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" dy="4" dx="${dx}">${Math.abs(pitch)}</text>`,
        );
      }
    }
  }
  setMarkup(group, cache, "ladder", marks.join(""));
}
