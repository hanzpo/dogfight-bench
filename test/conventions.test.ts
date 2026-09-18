import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { aeroRatesToRotationVector, bodyAxes } from "../src/sim/flight-model";
import { createNeutralMerge, neutralMerge } from "../src/sim/scenario";

/**
 * Frame conventions are the highest-risk thing in this codebase: a flipped sign
 * produces an aircraft that flies perfectly and turns the wrong way. These
 * tests pin every axis down explicitly.
 */

function rotate(p: number, q: number, r: number, seconds: number): Quaternion {
  const omega = aeroRatesToRotationVector(p, q, r);
  const angle = omega.length() * seconds;
  return new Quaternion().multiply(new Quaternion().setFromAxisAngle(omega.normalize(), angle));
}

describe("frame conventions", () => {
  it("places the nose along +z and the canopy along +y in body axes", () => {
    const axes = bodyAxes(new Quaternion());
    expect(axes.nose.toArray()).toEqual([0, 0, 1]);
    expect(axes.up.toArray()).toEqual([0, 1, 0]);
    // A right-handed y-up basis with the nose at +z puts +x on the aircraft's
    // left, so its right wing points along -x.
    expect(axes.right.x).toBeCloseTo(-1, 9);
  });

  it("rolls right for positive p", () => {
    const axes = bodyAxes(rotate(1, 0, 0, 0.5));
    // Right wing drops, and the canopy tilts toward where the right wing was.
    expect(axes.right.y).toBeLessThan(0);
    expect(axes.up.x).toBeLessThan(0);
  });

  it("pitches nose up for positive q", () => {
    expect(bodyAxes(rotate(0, 1, 0, 0.5)).nose.y).toBeGreaterThan(0);
  });

  it("yaws nose right for positive r", () => {
    const axes = bodyAxes(rotate(0, 0, 1, 0.5));
    // From the identity attitude the nose is along +z; yawing right must swing
    // it toward the right wing, which is -x.
    expect(axes.nose.x).toBeLessThan(0);
  });

  it("starts the merge with the jets closing head-on", () => {
    const state = createNeutralMerge();
    const [blue, red] = state.aircraft;
    expect(blue!.position.distanceTo(red!.position)).toBeCloseTo(neutralMerge.startSeparationM, 6);

    const separation = red!.position.clone().sub(blue!.position);
    expect(blue!.velocity.clone().normalize().dot(separation.clone().normalize())).toBeCloseTo(1, 3);
    expect(red!.velocity.clone().normalize().dot(separation.clone().normalize())).toBeCloseTo(-1, 3);
    expect(blue!.velocity.clone().normalize().dot(red!.velocity.clone().normalize())).toBeCloseTo(-1, 3);
  });

  it("orients both jets nose-first along their velocity", () => {
    for (const aircraft of createNeutralMerge().aircraft) {
      const nose = new Vector3(0, 0, 1).applyQuaternion(aircraft.orientation);
      expect(nose.dot(aircraft.velocity.clone().normalize())).toBeGreaterThan(0.999);
    }
  });
});
