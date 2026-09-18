import { useEffect, useRef, type RefObject } from "react";
import { bulletImpactPoint, hitThresholdM, solveGunsight, wouldConnect } from "../../sim/gunsight";
import type { MatchState } from "../../sim/types";
import type { DogfightViewer } from "../../viewer";
import { radians } from "../../math";

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
  const leadLine = useRef<SVGLineElement>(null);
  const rangeLabel = useRef<SVGTextElement>(null);
  const arrow = useRef<SVGGElement>(null);
  const shootCue = useRef<SVGGElement>(null);

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
        for (const element of [reticle.current, targetBox.current, arrow.current, leadLine.current, shootCue.current]) {
          hide(element);
        }
        return;
      }

      const range = own.position.distanceTo(bandit.position);
      const solution = solveGunsight({
        position: own.position,
        velocity: own.velocity,
        orientation: own.orientation,
        targetPosition: bandit.position,
        targetVelocity: bandit.velocity,
        targetAcceleration: bandit.acceleration,
      });

      const impact = bulletImpactPoint(own.position, own.velocity, own.orientation, range);
      const aim = viewer.project(impact);
      const aimX = aim.x * width;
      const aimY = aim.y * height;
      if (aim.behind) {
        hide(reticle.current);
      } else {
        show(reticle.current);
        reticle.current?.setAttribute("transform", `translate(${aimX.toFixed(1)} ${aimY.toFixed(1)})`);
        const spreadRadians = Math.atan2(hitThresholdM(range), Math.max(range, 1));
        const fieldOfView = radians(viewer.camera.fov);
        const radius = Math.max(6, Math.min(140, (spreadRadians / fieldOfView) * height));
        reticleRing.current?.setAttribute("r", radius.toFixed(1));
      }

      const target = viewer.project(bandit.position);
      const onScreen = !target.behind && target.x > 0 && target.x < 1 && target.y > 0 && target.y < 1;
      const targetX = target.x * width;
      const targetY = target.y * height;

      if (onScreen) {
        show(targetBox.current);
        hide(arrow.current);
        const apparent = Math.atan2(16, Math.max(range, 1));
        const fieldOfView = radians(viewer.camera.fov);
        const half = Math.max(11, Math.min(220, (apparent / fieldOfView) * height));
        boxRect.current?.setAttribute("x", (-half).toFixed(1));
        boxRect.current?.setAttribute("y", (-half).toFixed(1));
        boxRect.current?.setAttribute("width", (half * 2).toFixed(1));
        boxRect.current?.setAttribute("height", (half * 2).toFixed(1));
        targetBox.current?.setAttribute("transform", `translate(${targetX.toFixed(1)} ${targetY.toFixed(1)})`);
        rangeLabel.current?.setAttribute("y", (half + 15).toFixed(1));
        if (rangeLabel.current) {
          rangeLabel.current.textContent =
            range >= 1_000 ? `${(range / 1_000).toFixed(1)} KM` : `${Math.round(range)} M`;
        }

        if (!aim.behind) {
          show(leadLine.current);
          leadLine.current?.setAttribute("x1", aimX.toFixed(1));
          leadLine.current?.setAttribute("y1", aimY.toFixed(1));
          leadLine.current?.setAttribute("x2", targetX.toFixed(1));
          leadLine.current?.setAttribute("y2", targetY.toFixed(1));
        } else {
          hide(leadLine.current);
        }
      } else {
        hide(targetBox.current);
        hide(leadLine.current);
        show(arrow.current);
        const dx = (target.x - 0.5) * (target.behind ? -1 : 1);
        const dy = (target.y - 0.5) * (target.behind ? -1 : 1);
        const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const radius = Math.min(width, height) * 0.36;
        const cx = width / 2 + Math.cos(radians(angle)) * radius;
        const cy = height / 2 + Math.sin(radians(angle)) * radius;
        arrow.current?.setAttribute("transform", `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${angle.toFixed(1)})`);
      }

      const canHit = wouldConnect(solution) && own.ammo > 0;
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
      <line ref={leadLine} className="lead-line" x1="0" y1="0" x2="0" y2="0" visibility="hidden" />

      <g ref={reticle} className="reticle" visibility="hidden">
        <circle ref={reticleRing} r="26" />
        <line x1="-34" y1="0" x2="-12" y2="0" />
        <line x1="12" y1="0" x2="34" y2="0" />
        <line x1="0" y1="-34" x2="0" y2="-12" />
        <line x1="0" y1="12" x2="0" y2="34" />
        <circle className="pip" r="1.8" />
      </g>

      <g ref={targetBox} className="target-box" visibility="hidden">
        <rect ref={boxRect} x="-18" y="-18" width="36" height="36" />
        <text ref={rangeLabel} y="33" textAnchor="middle">
          0 M
        </text>
      </g>

      <g ref={arrow} className="bandit-arrow" visibility="hidden">
        <path d="M 0 0 L -22 -9 L -16 0 L -22 9 Z" />
      </g>

      <g ref={shootCue} className="shoot-cue" visibility="hidden">
        <text textAnchor="middle">SHOOT</text>
      </g>
    </svg>
  );
}
