import { useEffect, useRef, type RefObject } from "react";
import { airframe, missileSpec } from "../../sim/airframes";
import { bodyAxes } from "../../sim/flight-model";
import { bulletImpactPoint, hitThresholdM, solveGunsight, wouldConnect } from "../../sim/gunsight";
import { missileLaunchZone } from "../../sim/rwr";
import type { MatchState } from "../../sim/types";
import type { DogfightViewer } from "../../viewer";
import { radians } from "../../math";
import { clamp } from "../../math";

export function TacticalOverlay({
  stateRef,
  viewerRef,
  followId,
}: {
  stateRef: RefObject<MatchState | undefined>;
  viewerRef: RefObject<DogfightViewer | undefined>;
  followId: string;
}) {
  const root = useRef<SVGSVGElement>(null);
  const reticle = useRef<SVGGElement>(null);
  const reticleRing = useRef<SVGCircleElement>(null);
  const targetBox = useRef<SVGGElement>(null);
  const boxRect = useRef<SVGRectElement>(null);
  const rangeLabel = useRef<SVGTextElement>(null);
  const arrow = useRef<SVGGElement>(null);
  const shootCue = useRef<SVGGElement>(null);
  const seekerCircle = useRef<SVGCircleElement>(null);
  const lockDiamond = useRef<SVGGElement>(null);
  const lockLabel = useRef<SVGTextElement>(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const state = stateRef.current;
      const viewer = viewerRef.current;
      const svg = root.current;
      if (!state || !viewer || !svg) return;

      const own = state.aircraft.find((aircraft) => aircraft.id === followId);
      const bandit = state.aircraft.find((aircraft) => aircraft.id !== followId);
      const width = svg.clientWidth;
      const height = svg.clientHeight;
      if (!own || !bandit || !width || !height) return;

      const hide = (element: SVGElement | null) => element?.setAttribute("visibility", "hidden");
      const show = (element: SVGElement | null) => element?.setAttribute("visibility", "visible");

      if (!own.alive || !bandit.alive) {
        for (const element of [
          reticle.current,
          targetBox.current,
          arrow.current,
          shootCue.current,
          seekerCircle.current,
          lockDiamond.current,
        ]) {
          hide(element);
        }
        return;
      }

      const range = own.position.distanceTo(bandit.position);
      const jet = airframe(own.airframe);
      const gun = jet.gun;
      const solution = solveGunsight({
        position: own.position,
        velocity: own.velocity,
        orientation: own.orientation,
        targetPosition: bandit.position,
        targetVelocity: bandit.velocity,
        targetAcceleration: bandit.acceleration,
        gun,
      });

      const impact = bulletImpactPoint(own.position, own.velocity, own.orientation, range, gun);
      const aim = viewer.project(impact);
      const aimX = aim.x * width;
      const aimY = aim.y * height;
      if (aim.behind) {
        hide(reticle.current);
      } else {
        show(reticle.current);
        reticle.current?.setAttribute("transform", `translate(${aimX.toFixed(1)} ${aimY.toFixed(1)})`);
        const spreadRadians = Math.atan2(hitThresholdM(range, gun), Math.max(range, 1));
        const fieldOfView = radians(viewer.camera.fov);
        const radius = clamp((spreadRadians / fieldOfView) * height, 6, 140);
        reticleRing.current?.setAttribute("r", radius.toFixed(1));
      }

      /**
       * The missile's seeker: a circle the size of its acquisition cone,
       * slaved to the nose, until it has tone -- then a diamond on whatever it
       * is tracking, which need not be where the nose is pointing.
       */
      const drawSeeker = () => {
        const seeker = own.seeker;
        if (own.stores.missiles <= 0 || seeker.tone === "off") {
          hide(seekerCircle.current);
          hide(lockDiamond.current);
          return;
        }
        if (seeker.tone === "lock") {
          hide(seekerCircle.current);
          const locked = viewer.project(bandit.position);
          if (locked.behind) {
            hide(lockDiamond.current);
            return;
          }
          show(lockDiamond.current);
          lockDiamond.current?.setAttribute(
            "transform",
            `translate(${(locked.x * width).toFixed(1)} ${(locked.y * height).toFixed(1)})`,
          );
          const zone = missileLaunchZone(own, bandit);
          const inRange = range >= zone.minM && range <= zone.maxM;
          if (lockLabel.current) {
            const label = inRange ? "SHOOT" : range > zone.maxM ? "LOCK · OUT OF RANGE" : "LOCK · TOO CLOSE";
            if (lockLabel.current.textContent !== label) lockLabel.current.textContent = label;
            lockLabel.current.setAttribute("class", inRange ? "lock-label in-range" : "lock-label");
          }
          return;
        }
        hide(lockDiamond.current);
        const axes = bodyAxes(own.orientation);
        const ahead = own.position.clone().addScaledVector(axes.nose, 1_000);
        const centre = viewer.project(ahead);
        const edge = viewer.project(ahead.clone().addScaledVector(axes.up, Math.tan(missileSpec(jet.missile).acquisitionConeRad) * 1_000));
        if (centre.behind || edge.behind) {
          hide(seekerCircle.current);
          return;
        }
        show(seekerCircle.current);
        const radius = Math.hypot((edge.x - centre.x) * width, (edge.y - centre.y) * height);
        seekerCircle.current?.setAttribute("cx", (centre.x * width).toFixed(1));
        seekerCircle.current?.setAttribute("cy", (centre.y * height).toFixed(1));
        seekerCircle.current?.setAttribute("r", clamp(radius, 8, 400).toFixed(1));
        seekerCircle.current?.setAttribute("class", `seeker-circle ${seeker.tone}`);
      };

      const target = viewer.project(bandit.position);
      const onScreen = !target.behind && target.x > 0 && target.x < 1 && target.y > 0 && target.y < 1;
      const targetX = target.x * width;
      const targetY = target.y * height;

      if (onScreen) {
        show(targetBox.current);
        hide(arrow.current);
        const apparent = Math.atan2(16, Math.max(range, 1));
        const fieldOfView = radians(viewer.camera.fov);
        const half = clamp((apparent / fieldOfView) * height, 11, 220);
        boxRect.current?.setAttribute("x", (-half).toFixed(1));
        boxRect.current?.setAttribute("y", (-half).toFixed(1));
        boxRect.current?.setAttribute("width", (half * 2).toFixed(1));
        boxRect.current?.setAttribute("height", (half * 2).toFixed(1));
        targetBox.current?.setAttribute("transform", `translate(${targetX.toFixed(1)} ${targetY.toFixed(1)})`);
        rangeLabel.current?.setAttribute("x", (half + 6).toFixed(1));
        rangeLabel.current?.setAttribute("y", (half + 4).toFixed(1));
        if (rangeLabel.current) {
          rangeLabel.current.textContent =
            range >= 1_000 ? `${(range / 1_000).toFixed(1)} KM` : `${Math.round(range)} M`;
        }

      } else {
        hide(targetBox.current);
        show(arrow.current);
        const dx = (target.x - 0.5) * (target.behind ? -1 : 1);
        const dy = (target.y - 0.5) * (target.behind ? -1 : 1);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const radius = Math.min(width, height) * 0.36;
        const cx = width / 2 + Math.cos(radians(angle)) * radius;
        const cy = height / 2 + Math.sin(radians(angle)) * radius;
        arrow.current?.setAttribute("transform", `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${angle.toFixed(1)})`);
      }

      drawSeeker();

      const canHit = wouldConnect(solution, gun) && own.ammo > 0;
      if (canHit) {
        show(shootCue.current);
        const onScreenAim =
          !aim.behind && aimX > 30 && aimX < width - 30 && aimY > 70 && aimY < height - 130;
        const cueX = onScreenAim ? aimX : width / 2;
        const cueY = onScreenAim ? aimY - 46 : height * 0.74;
        shootCue.current?.setAttribute("transform", `translate(${cueX.toFixed(1)} ${cueY.toFixed(1)})`);
        reticleRing.current?.setAttribute("stroke", "var(--shoot)");
      } else {
        hide(shootCue.current);
        reticleRing.current?.setAttribute("stroke", "var(--hud)");
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [stateRef, viewerRef, followId]);

  return (
    <svg ref={root} className="tactical" aria-hidden>
      <g ref={reticle} className="reticle" visibility="hidden">
        <circle ref={reticleRing} r="26" />
        <circle className="pip" r="1.6" />
      </g>

      <g ref={targetBox} className="target-box" visibility="hidden">
        <rect ref={boxRect} x="-18" y="-18" width="36" height="36" />
        <text ref={rangeLabel} y="33">
          0 M
        </text>
      </g>

      <g ref={arrow} className="bandit-arrow" visibility="hidden">
        <path d="M -9 -7 L 0 0 L -9 7" />
      </g>

      <circle ref={seekerCircle} className="seeker-circle" r="40" visibility="hidden" />

      <g ref={lockDiamond} className="lock-diamond" visibility="hidden">
        <path d="M 0 -14 L 14 0 L 0 14 L -14 0 Z" />
        <text ref={lockLabel} className="lock-label" y="-20" textAnchor="middle">
          LOCK
        </text>
      </g>

      <g ref={shootCue} className="shoot-cue" visibility="hidden">
        <text textAnchor="middle">SHOOT</text>
      </g>
    </svg>
  );
}
