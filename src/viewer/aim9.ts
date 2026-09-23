import * as THREE from "three";

/**
 * An AIM-9M, built rather than loaded: a handful of lathed and extruded
 * pieces in the body axes the aircraft uses, nose along +z, centred on its
 * length.
 *
 * Proportions are the real missile's: 2.87 m long, 127 mm across, the
 * double-delta canards of the guidance section just behind the seeker dome,
 * yellow and brown bands over the warhead and motor, and the tail fins with a rolleron -- the little slipstream-spun
 * wheel that stops it rolling -- in each trailing corner.
 */
export const AIM9_LENGTH_M = 2.87;
const RADIUS = 0.0635;
const HALF = AIM9_LENGTH_M / 2;

const DOME_RADIUS = 0.052;
const GUIDANCE_LENGTH = 0.62;
const WARHEAD_LENGTH = 0.3;
const CANARD_ROOT_Z = HALF - 0.2;

function lathe(profile: Array<[number, number]>, segments = 20): THREE.LatheGeometry {
  // Lathe turns about y; the profile is (radius, along-axis) and the result is
  // turned so the axis lies along z, nose forward.
  // Faces point outward only when the profile runs up the axis, tail to nose.
  const ordered = profile[0]![1] > profile.at(-1)![1] ? [...profile].reverse() : profile;
  const points = ordered.map(([radius, along]) => new THREE.Vector2(radius, along));
  return new THREE.LatheGeometry(points, segments).rotateX(Math.PI / 2);
}

/** Shape (span, along) extruded through its thickness; span, along, thickness map to y, z, x. */
const FIN_AXES = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);

function fin(outline: Array<[number, number]>, thickness: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([span, along]) => new THREE.Vector2(span, along)));
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
    .translate(0, 0, -thickness / 2)
    .applyMatrix4(FIN_AXES);
}

export interface Aim9Materials {
  body: THREE.Material;
  dome: THREE.Material;
  warheadBand: THREE.Material;
  motorBand: THREE.Material;
  nozzle: THREE.Material;
}

export function aim9Materials(): Aim9Materials {
  return {
    body: new THREE.MeshStandardMaterial({ color: 0xd8dad4, roughness: 0.5, metalness: 0.25 }),
    dome: new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.08, metalness: 0.6 }),
    warheadBand: new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6 }),
    motorBand: new THREE.MeshStandardMaterial({ color: 0x7a5530, roughness: 0.7 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8, metalness: 0.4 }),
  };
}

export function createAim9(materials: Aim9Materials): THREE.Group {
  const missile = new THREE.Group();
  missile.name = "AIM-9M";

  const noseZ = HALF;
  const guidanceEnd = noseZ - GUIDANCE_LENGTH;
  const warheadEnd = guidanceEnd - WARHEAD_LENGTH;
  const tailZ = -HALF;

  // The seeker dome: a glass hemisphere on a short taper.
  const dome = new THREE.SphereGeometry(DOME_RADIUS, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
  const domeMesh = new THREE.Mesh(dome, materials.dome);
  domeMesh.position.z = noseZ - DOME_RADIUS * 0.35;
  missile.add(domeMesh);

  missile.add(
    new THREE.Mesh(
      lathe([
        [DOME_RADIUS, noseZ - DOME_RADIUS * 0.35],
        [RADIUS * 0.96, noseZ - 0.09],
        [RADIUS, noseZ - 0.14],
        [RADIUS, guidanceEnd],
      ]),
      materials.body,
    ),
  );
  missile.add(new THREE.Mesh(lathe([[RADIUS * 1.004, guidanceEnd], [RADIUS * 1.004, warheadEnd]]), materials.warheadBand));
  missile.add(new THREE.Mesh(lathe([[RADIUS, warheadEnd], [RADIUS, warheadEnd - 0.06]]), materials.body));
  missile.add(
    new THREE.Mesh(lathe([[RADIUS * 1.004, warheadEnd - 0.06], [RADIUS * 1.004, warheadEnd - 0.14]]), materials.motorBand),
  );
  missile.add(new THREE.Mesh(lathe([[RADIUS, warheadEnd - 0.14], [RADIUS, tailZ + 0.02]]), materials.body));
  missile.add(
    new THREE.Mesh(
      lathe([
        [RADIUS * 0.98, tailZ + 0.02],
        [RADIUS * 0.8, tailZ],
        [RADIUS * 0.55, tailZ],
      ]),
      materials.nozzle,
    ),
  );

  // Double-delta canards: a steep leading edge that breaks to a shallower one.
  const canard = fin(
    [
      [0, CANARD_ROOT_Z],
      [0.09, CANARD_ROOT_Z - 0.09],
      [0.16, CANARD_ROOT_Z - 0.2],
      [0.16, CANARD_ROOT_Z - 0.24],
      [0, CANARD_ROOT_Z - 0.24],
    ].map(([span, along]) => [span! + RADIUS, along!] as [number, number]),
    0.008,
  );
  // Tail fins: long root chord, swept leading edge, square tip.
  const tailFin = fin(
    [
      [0, tailZ + 0.62],
      [0.25, tailZ + 0.2],
      [0.25, tailZ + 0.06],
      [0, tailZ + 0.06],
    ].map(([span, along]) => [span! + RADIUS, along!] as [number, number]),
    0.01,
  );
  const rolleron = new THREE.CylinderGeometry(0.045, 0.045, 0.012, 16).rotateZ(Math.PI / 2);

  // X configuration: fins at the diagonals, as the missile is carried.
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const roll = Math.PI / 4 + (quarter * Math.PI) / 2;
    const station = new THREE.Group();
    station.rotation.z = roll;
    station.add(new THREE.Mesh(canard, materials.body));
    station.add(new THREE.Mesh(tailFin, materials.body));
    const wheel = new THREE.Mesh(rolleron, materials.body);
    wheel.position.set(0, RADIUS + 0.23, tailZ + 0.1);
    station.add(wheel);
    missile.add(station);
  }
  return missile;
}
