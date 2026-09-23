import { useEffect, useRef, type RefObject } from "react";
import { Vector3 } from "three";
import { atmosphere, equivalentAirspeed } from "../../sim/atmosphere";
import { bodyAxes } from "../../sim/flight-model";
import { rwrContacts, type RwrContact } from "../../sim/rwr";
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

const RWR_RADIUS = 46;

export function FlightDisplay({
  stateRef,
  viewerRef,
  followId,
  detailsOpen,
}: {
  stateRef: RefObject<MatchState | undefined>;
  viewerRef: RefObject<DogfightViewer | undefined>;
  followId: string;
  detailsOpen: boolean;
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

      layout(groups.current, width, height, details.current);

      const axes = bodyAxes(own.orientation);
      const speed = own.velocity.length();
      const air = atmosphere(own.position.y);
      const cockpit = viewer.viewMode === "cockpit";

      const heading = compass(axes.nose);
      const track = speed > 1 ? compass(own.velocity) : heading;

      const set = (key: string, value: string) => {
        const node = text.current[key];
        if (node && node.textContent !== value) node.textContent = value;
      };

      set("cas", String(Math.round(equivalentAirspeed(speed, own.position.y) * KNOTS)));
      set("mach", `M ${(speed / air.speedOfSoundMps).toFixed(2)}`);
      set("g", `${own.loadFactor.toFixed(1)}G`);
      set("alt", Math.round(own.position.y * FEET).toLocaleString());
      set("agl", `R ${Math.round(own.heightAboveGroundM * FEET).toLocaleString()}`);
      set("vs", signedCount(own.velocity.y * FEET * 60));
      set("heading", String(Math.round(heading)).padStart(3, "0"));
      set("track", `TRK ${String(Math.round(track)).padStart(3, "0")}`);
      set("aoa", `${degrees(own.aoaRad).toFixed(1)}° AOA`);
      set("fuel", `${Math.round(own.engine.fuelKg)} KG`);
      set("ammo", String(own.ammo));
      const armed = own.stores.missileStations > 0;
      // Removed rather than hidden: a hidden SVG group still has a size, and the
      // missile columns would push the stores readout into the throttle's space
      // on a narrow window in a fight that has no missiles.
      groups.current["srm"]?.setAttribute("display", armed ? "inline" : "none");
      groups.current["rwr"]?.setAttribute("display", armed ? "inline" : "none");
      if (armed) {
        set("missiles", String(own.stores.missiles));
        set("seeker", own.stores.missiles > 0 ? SEEKER_LABEL[own.seeker.tone] : "");
        set("flares", String(own.stores.flares));
        const contacts = rwrContacts(state, own.id);
        drawRwr(rwrContactsGroup.current, rendered.current, contacts);
        const inbound = contacts
          .filter((contact) => contact.kind === "missile")
          .sort((a, b) => (a.timeToGoS ?? Infinity) - (b.timeToGoS ?? Infinity))[0];
        missileWarning.current?.setAttribute("visibility", inbound ? "visible" : "hidden");
        if (inbound) {
          set("warning", `MISSILE ${clock(inbound.bearingDeg)} O'CLOCK`);
          set("warningDetail", `${(inbound.rangeM / 1_000).toFixed(1)} KM · ${Math.max(0, inbound.timeToGoS ?? 0).toFixed(1)} S`);
        }
      } else {
        missileWarning.current?.setAttribute("visibility", "hidden");
      }
      set("throttleLabel", throttleLabel(own.engine.afterburner, own.controls.throttle));
      throttleFill.current?.setAttribute("width", (clamp(own.controls.throttle, 0, 1) * 84).toFixed(1));
      throttleFill.current?.setAttribute("fill", own.engine.afterburner ? "var(--ab)" : "currentColor");

      stickDot.current?.setAttribute("cx", (clamp(own.controls.roll, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
      stickDot.current?.setAttribute("cy", (-clamp(own.controls.pitch, -1, 1) * CONTROL_BOX_HALF).toFixed(1));
      const rudder = clamp(own.controls.yaw, -1, 1) * CONTROL_BOX_HALF;
      rudderBar.current?.setAttribute("x", Math.min(0, rudder).toFixed(1));
      rudderBar.current?.setAttribute("width", Math.abs(rudder).toFixed(1));

      renderTape(
        speedTicks.current,
        rendered.current,
        "speed",
        equivalentAirspeed(speed, own.position.y) * KNOTS,
        20,
        100,
        height,
        false,
        panelScale(width, height),
      );
      renderTape(
        altTicks.current,
        rendered.current,
        "alt",
        own.position.y * FEET,
        500,
        2_000,
        height,
        true,
        panelScale(width, height),
      );
      renderHeadingTape(headingTicks.current, rendered.current, heading, width);

      if (cockpit) {
        conformal.current?.setAttribute("visibility", "visible");
        sizeHudField(hudField.current, viewer, width, height);
        drawLadder(ladder.current, rendered.current, own.position, axes.nose, viewer, width, height);

        if (speed > 1) {
          const marker = viewer.project(own.position.clone().addScaledVector(own.velocity.clone().normalize(), HUD_RANGE));
          if (!marker.behind) {
            flightPath.current?.setAttribute("visibility", "visible");
            flightPath.current?.setAttribute(
              "transform",
              `translate(${(marker.x * width).toFixed(1)} ${(marker.y * height).toFixed(1)})`,
            );
            aoaBracket.current?.setAttribute("visibility", own.flcs.limiterActive ? "visible" : "hidden");
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
  }, [stateRef, viewerRef, followId]);

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
          <circle r="9" />
          <line x1="-19" y1="0" x2="-9" y2="0" />
          <line x1="9" y1="0" x2="19" y2="0" />
          <line x1="0" y1="-9" x2="0" y2="-17" />
          <g ref={aoaBracket} className="aoa-bracket" visibility="hidden">
            <path d="M -30 -9 L -36 -9 L -36 9 L -30 9" />
          </g>
        </g>
      </g>

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

      <g ref={group("heading")} className="heading-group">
        <g ref={headingTicks} className="tape-ticks" />
        <path className="heading-caret" d="M 0 4 L -6 13 L 6 13 Z" />
        <g className="tape-box">
          <rect x="-25" y="-19" width="50" height="22" />
          <text ref={label("heading")} y="-3" textAnchor="middle">
            000
          </text>
        </g>
        <text ref={label("track")} className="tape-sub" y="54" textAnchor="middle">
          TRK 000
        </text>
      </g>

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
        <g ref={group("srm")} display="none">
          <text className="tape-caption" x="-64" y="-8" textAnchor="end">
            AIM-9M
          </text>
          <text ref={label("missiles")} className="stores-value" x="-64" y="14" textAnchor="end">
            2
          </text>
          <text ref={label("seeker")} className="tape-sub seeker-state" x="-64" y="30" textAnchor="end">
            SRCH
          </text>
          <text className="tape-caption" x="-136" y="-8" textAnchor="end">
            FLARES
          </text>
          <text ref={label("flares")} className="stores-value" x="-136" y="14" textAnchor="end">
            30
          </text>
        </g>
      </g>

      <g ref={group("rwr")} className="rwr" display="none">
        <circle className="rwr-scope" r={RWR_RADIUS} />
        <circle className="rwr-ring" r={RWR_RADIUS / 2} />
        <path className="rwr-ownship" d="M 0 -6 L 0 6 M -6 1 L 6 1 M -3 5 L 3 5" />
        <text className="tape-caption" y={-RWR_RADIUS - 8} textAnchor="middle">
          RWR
        </text>
        <g ref={rwrContactsGroup} />
      </g>

      <g ref={group("warning")}>
      <g ref={missileWarning} className="missile-warning" visibility="hidden">
        <text ref={label("warning")} className="missile-warning-title" textAnchor="middle">
          MISSILE
        </text>
        <text ref={label("warningDetail")} className="missile-warning-detail" y="18" textAnchor="middle">
          0.0 KM
        </text>
      </g>
      </g>
    </svg>
  );
}

const UP = new Vector3(0, 1, 0);

const SEEKER_LABEL = { off: "", search: "SRCH", growl: "GROWL", lock: "LOCK" } as const;

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
      contact.kind === "missile" ? RWR_RADIUS * 0.34 : contact.level === "track" ? RWR_RADIUS * 0.62 : RWR_RADIUS * 0.84;
    const angle = (contact.bearingDeg * Math.PI) / 180;
    const x = (Math.sin(angle) * radius).toFixed(1);
    const y = (-Math.cos(angle) * radius).toFixed(1);
    if (contact.kind === "missile") {
      return `<g class="rwr-missile" transform="translate(${x} ${y})"><path d="M 0 -8 L 7 6 L -7 6 Z" /><text y="4" text-anchor="middle">M</text></g>`;
    }
    const box = contact.level === "track" ? `<path class="rwr-track" d="M 0 -10 L 10 0 L 0 10 L -10 0 Z" />` : "";
    return `<g class="rwr-radar" transform="translate(${x} ${y})">${box}<text y="4" text-anchor="middle">16</text></g>`;
  });
  setMarkup(group, cache, "rwr", marks.join(""));
}

function throttleLabel(afterburner: boolean, throttle: number): string {
  if (afterburner) return "AB";
  if (throttle <= 0.02) return "IDLE";
  return `${Math.round(throttle * 100)}%`;
}

/** How much the panel instruments shrink on a small window. */
function panelScale(width: number, height: number): number {
  return clamp(Math.min(width / 1_500, height / 880), 0.82, 1.3);
}

/**
 * The band the airspeed and altitude readouts occupy, either side of centre.
 *
 * The tape runs behind them, so a tick label landing inside this would be drawn
 * across the Mach number or the angle of attack.
 */
function readoutBand(scale: number): { top: number; bottom: number } {
  return { top: -30 * scale, bottom: 84 * scale };
}

function layout(
  groups: Record<string, SVGGElement | null>,
  width: number,
  height: number,
  detailsOpen: boolean,
): void {
  const scale = panelScale(width, height);
  const margin = clamp(width * 0.05, 26, 92);
  const rightEdge = width - (detailsOpen ? 318 : margin);
  const place = (key: string, x: number, y: number, scaled = true) =>
    groups[key]?.setAttribute(
      "transform",
      `translate(${x.toFixed(1)} ${y.toFixed(1)})${scaled ? ` scale(${scale.toFixed(3)})` : ""}`,
    );

  place("speed", margin, 0, false);
  place("speedReadout", 0, height / 2);
  place("alt", rightEdge, 0, false);
  place("altReadout", 0, height / 2);
  place("heading", width / 2, 86);
  // Measured off the control bar rather than assumed: the bar wraps to two rows
  // on a narrow window, and a fixed offset put the throttle and the ammunition
  // count underneath it.
  const bar = document.querySelector(".controls")?.getBoundingClientRect().top;
  // With no bar -- the game screen has none -- the instruments sit at the bottom edge.
  const bottom = (bar === undefined ? height - 24 : bar > height * 0.4 ? bar : height - 132) - 42;
  place("engine", margin, bottom);
  place("stores", rightEdge, bottom);
  // Above the throttle, clear of the airspeed readout that ends a little
  // below the middle of the screen.
  const rwrY = Math.max(height / 2 + 150 * scale, bottom - 100 * scale);
  place("rwr", margin + (RWR_RADIUS + 4) * scale, rwrY);
  // Below the heading tape and its track readout.
  place("warning", width / 2, 196);
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

function renderTape(
  group: SVGGElement | null,
  cache: Record<string, string>,
  key: string,
  value: number,
  step: number,
  span: number,
  height: number,
  right: boolean,
  scale: number,
): void {
  if (!group) return;
  const signature = `${Math.round(value)}|${Math.round(height)}|${scale.toFixed(2)}`;
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
    const band = readoutBand(scale);
    if (major && (y - centre < band.top || y - centre > band.bottom)) {
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
