import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { clamp, radians } from "../math";
import { terrainHeight } from "../sim/terrain";
import type { ViewerAircraft } from "./types";
import { airframe, fromModel } from "../sim/airframes";

export type ViewMode = "free" | "chase" | "track" | "arena" | "cockpit";

const AUTOMATIC_VIEWS: readonly ViewMode[] = ["chase", "track", "arena", "cockpit"];

const BODY_FORWARD = new THREE.Vector3(0, 0, 1);
const BODY_UP = new THREE.Vector3(0, 1, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** three cameras look down -z, the aircraft's nose is +z, so turn them around. */
const NOSE_FORWARD = new THREE.Quaternion().setFromAxisAngle(BODY_UP, Math.PI);

const ORBIT_RADIANS_PER_PIXEL = 0.005;

/** How far in and out a self-placing view may be pushed, against its natural framing. */
const MIN_FRAMING = 0.35;
const MAX_FRAMING = 4;
/** The cockpit zooms by field of view, because the pilot's eye cannot move. */
const COCKPIT_MIN_FOV = 18;
const COCKPIT_MAX_FOV = 75;

const CHASE_DISTANCE_M = 62;
const CHASE_RISE = 0.2;
/** The aircraft sits `atan` of this below the view axis, so 0.05 is three degrees low. */
const CHASE_AIM_ABOVE = 0.05;

const TRACK_LIFT = 0.1;
const TRACK_NEAR_M = 46;
const TRACK_PER_METRE = 0.05;
const TRACK_MAX_M = 200;

const ARENA_ELEVATION_DEG = 26;
const ARENA_GROUND_CLEARANCE_M = 60;
/** How far off centre the arena camera may look and still hold what it sees in frame. */
const ARENA_FRAMED = 0.55;
const ARENA_MIN_M = 200;
/**
 * Past this the bandit is allowed out of frame. "Both in shot" and "you can see
 * them" stop being the same request beyond a kilometre: framing a five-kilometre
 * split puts two aeroplanes on screen as two pixels.
 */
const ARENA_MAX_M = 1_100;

/** How fast each view settles into a new offset, per second. */
const CHASE_EASE = 6;
const ARENA_EASE = 1.6;

export class CameraDirector {
  private view: ViewMode = "free";
  private pointerCaptured = false;
  /** How far off the automatic views stand, as a multiple of their natural framing. */
  private framing = 1;
  private lastFrameMs = 0;
  private placed = false;
  private readonly offset = new THREE.Vector3();

  /** The field of view the cockpit zooms away from and back to. */
  private readonly baseFov: number;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {
    this.baseFov = camera.fov;
    this.applyControlAvailability();
  }

  get mode(): ViewMode {
    return this.view;
  }

  get automatic(): boolean {
    return AUTOMATIC_VIEWS.includes(this.view);
  }

  setView(view: ViewMode): void {
    if (view === this.view) return;
    this.view = view;
    this.framing = 1;
    this.setFov(this.baseFov);
    this.reset();
    this.applyControlAvailability();
  }

  setPointerCaptured(captured: boolean): void {
    if (this.pointerCaptured === captured) return;
    this.pointerCaptured = captured;
    this.applyControlAvailability();
  }

  reset(): void {
    this.placed = false;
  }

  private applyControlAvailability(): void {
    this.controls.enabled = !this.automatic && !this.pointerCaptured;
  }

  /**
   * Driven by hand rather than by OrbitControls because a mouse pilot's pointer
   * may be captured, and a captured pointer reports movement deltas but never
   * moves its client coordinates -- which is all OrbitControls looks at.
   */
  orbitBy(deltaXPixels: number, deltaYPixels: number): void {
    if (this.automatic) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= deltaXPixels * ORBIT_RADIANS_PER_PIXEL;
    spherical.phi = clamp(
      spherical.phi - deltaYPixels * ORBIT_RADIANS_PER_PIXEL,
      this.controls.minPolarAngle,
      this.controls.maxPolarAngle,
    );
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(spherical));
    this.camera.lookAt(this.controls.target);
  }

  /**
   * The wheel, in whatever view is current.
   *
   * There is no one thing zooming means. From the cockpit the eye cannot move,
   * so it narrows the field of view, the way a pilot looking harder at a speck
   * does not lean forward. Everywhere else the camera itself moves: a view that
   * places itself changes how far off it stands, and the free view dollies.
   */
  zoomBy(factor: number): void {
    if (this.view === "cockpit") {
      this.setFov(clamp(this.camera.fov * factor, COCKPIT_MIN_FOV, COCKPIT_MAX_FOV));
      return;
    }
    if (this.automatic) {
      this.framing = clamp(this.framing * factor, MIN_FRAMING, MAX_FRAMING);
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance));
  }

  private setFov(fov: number): void {
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Returns true when the followed aircraft must not be drawn, which is only the cockpit. */
  update(follow: ViewerAircraft, centre: THREE.Vector3, bandit: THREE.Vector3 | undefined): boolean {
    switch (this.view) {
      case "cockpit":
        this.placeCockpit(follow);
        return true;
      case "chase":
        this.placeChase(follow, centre);
        return false;
      case "track":
        if (bandit) this.placeTrack(centre, bandit);
        return false;
      case "arena":
        if (bandit) this.placeArena(centre, bandit);
        return false;
      default:
        this.placeFree(follow, centre);
        this.controls.update();
        return false;
    }
  }

  /**
   * Places the camera at an offset from something, easing the offset.
   *
   * The offset is what is smoothed, not the world position. Smoothing the
   * position makes the camera lag by speed divided by the rate -- forty metres
   * at a quarter of a kilometre a second -- so the faster the aircraft flies the
   * further away it appears. Easing the offset leaves translation exact and
   * smooths only the direction the camera stands in.
   */
  private place(anchor: THREE.Vector3, offset: THREE.Vector3, lookAt: THREE.Vector3, perSecond: number): void {
    const now = performance.now();
    const elapsedS = this.lastFrameMs > 0 ? Math.min((now - this.lastFrameMs) / 1000, 0.1) : 0;
    this.lastFrameMs = now;

    if (!this.placed || !Number.isFinite(perSecond)) {
      this.offset.copy(offset);
      this.placed = true;
    } else {
      this.offset.lerp(offset, 1 - Math.exp(-perSecond * elapsedS));
    }

    this.camera.position.copy(anchor).add(this.offset);
    this.camera.up.copy(WORLD_UP);
    this.camera.lookAt(lookAt);
    this.controls.target.copy(lookAt);
  }

  /** Near the vertical, heading means nothing, so "behind" blends to the body's own up. */
  private placeChase(aircraft: ViewerAircraft, centre: THREE.Vector3): void {
    const orientation = new THREE.Quaternion().fromArray(aircraft.orientation);
    const forward = BODY_FORWARD.clone().applyQuaternion(orientation);
    const vertical = clamp((Math.abs(forward.y) - 0.7) / 0.25, 0, 1);
    const up = WORLD_UP.clone().lerp(BODY_UP.clone().applyQuaternion(orientation), vertical).normalize();

    const distance = CHASE_DISTANCE_M * this.framing;
    this.place(
      centre,
      forward.clone().multiplyScalar(-distance).addScaledVector(up, distance * CHASE_RISE),
      centre.clone().addScaledVector(up, distance * CHASE_AIM_ABOVE),
      CHASE_EASE,
    );
  }

  /** Placed exactly, not eased: a camera that lags a turn is no longer on the line. */
  private placeTrack(centre: THREE.Vector3, bandit: THREE.Vector3): void {
    const axis = centre.clone().sub(bandit);
    const separation = axis.length();
    axis.normalize();
    if (separation < 1) axis.set(0, 0, -1);

    const distance = Math.min(TRACK_NEAR_M + separation * TRACK_PER_METRE, TRACK_MAX_M) * this.framing;
    const lift = new THREE.Vector3().crossVectors(axis, WORLD_UP).cross(axis);
    if (lift.lengthSq() < 1e-6) lift.copy(BODY_UP);
    lift.normalize();

    this.place(
      centre,
      axis.clone().multiplyScalar(distance).addScaledVector(lift, distance * TRACK_LIFT),
      bandit,
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * `framed` is how far off centre this camera may look and still hold what it
   * sees in frame, so it aims at the midpoint while the midpoint is within that
   * reach, and otherwise slides back along the line until the followed aircraft
   * is.
   */
  private placeArena(centre: THREE.Vector3, bandit: THREE.Vector3): void {
    const midpoint = centre.clone().add(bandit).multiplyScalar(0.5);
    const separation = centre.distanceTo(bandit);

    const framed = Math.tan(radians(this.camera.fov) / 2) * ARENA_FRAMED;
    const distance = clamp(separation / 2 / framed, ARENA_MIN_M, ARENA_MAX_M) * this.framing;
    const lookAt = centre.clone().add(midpoint.clone().sub(centre).clampLength(0, distance * framed));

    const broadside = new THREE.Vector3(bandit.z - centre.z, 0, centre.x - bandit.x);
    if (broadside.lengthSq() < 1e-6) broadside.set(1, 0, 0);
    broadside.normalize();

    const elevation = radians(ARENA_ELEVATION_DEG);
    const offset = broadside
      .clone()
      .multiplyScalar(distance * Math.cos(elevation))
      .addScaledVector(WORLD_UP, distance * Math.sin(elevation));
    const floor = terrainHeight(lookAt.x + offset.x, lookAt.z + offset.z) + ARENA_GROUND_CLEARANCE_M;
    offset.y = Math.max(offset.y, floor - lookAt.y);

    this.place(lookAt, offset, lookAt, ARENA_EASE);
  }

  private placeCockpit(aircraft: ViewerAircraft): void {
    const orientation = new THREE.Quaternion().fromArray(aircraft.orientation);
    // The pilot's eye in body axes, up out of the seat and forward under the canopy.
    const frame = airframe(aircraft.airframe);
    const [right, up, nose] = fromModel(frame, frame.cockpitEye);
    this.camera.position
      .set(-right, up, nose)
      .applyQuaternion(orientation)
      .add(new THREE.Vector3().fromArray(aircraft.position));
    this.camera.quaternion.copy(orientation).multiply(NOSE_FORWARD);
    this.placed = false;
  }

  private placeFree(aircraft: ViewerAircraft, centre: THREE.Vector3): void {
    if (!this.placed) {
      const orientation = new THREE.Quaternion().fromArray(aircraft.orientation);
      this.camera.position.copy(centre).add(new THREE.Vector3(18, 8, -32).applyQuaternion(orientation));
      this.camera.up.copy(WORLD_UP);
      this.placed = true;
    } else {
      this.camera.position.add(centre.clone().sub(this.controls.target));
    }
    this.controls.target.copy(centre);
  }
}

