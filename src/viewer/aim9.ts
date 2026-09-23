import * as THREE from "three";

/**
 * An AIM-9M, built rather than loaded: lathed and extruded pieces in the body
 * axes the aircraft uses, nose along +z, centred on its length.
 *
 * Laid out from the L/M's own sections, front to back: a full-diameter seeker
 * dome on the dark guidance and control section, which carries the long-span
 * pointed double-delta canards that mark an L or M from every Sidewinder
 * before it; the DSU-15 laser fuze, a short ring of windows; the WDU-17
 * warhead under a yellow band; and the Mk 36 motor under a brown one, with
 * the tail fins and their rollerons at the back. Dimensions are the real
 * missile's: 2.85 m long, 127 mm across, 0.64 m across the canards and 0.63 m
 * across the fins.
 */
export const AIM9_LENGTH_M = 2.85;
const RADIUS = 0.0635;
const HALF = AIM9_LENGTH_M / 2;

const NOSE = HALF;
const GUIDANCE_END = NOSE - 0.8;
const FUZE_END = GUIDANCE_END - 0.165;
const WARHEAD_END = FUZE_END - 0.29;
const TAIL = -HALF;

/** Canard, measured back from the nose and out from the skin. */
const CANARD = {
  rootFront: 0.2,
  strakeBreak: { along: 0.36, span: 0.045 },
  tip: { along: 0.64, span: 0.256 },
  rootBack: 0.7,
} as const;

/** Tail fin, measured forward from the tail and out from the skin. */
const FIN = {
  rootFront: 0.47,
  tipFront: 0.2,
  span: 0.25,
  rootBack: 0.03,
} as const;

function lathe(profile: Array<[number, number]>, segments = 24): THREE.LatheGeometry {
  // Lathe turns about y and its faces point outward only when the profile runs
  // up the axis, so it is laid out tail to nose and then turned onto z.
  const ordered = profile[0]![1] > profile.at(-1)![1] ? [...profile].reverse() : profile;
  const points = ordered.map(([radius, along]) => new THREE.Vector2(radius, along));
  return new THREE.LatheGeometry(points, segments).rotateX(Math.PI / 2);
}

/** Shape (span, along) extruded through its thickness; span, along, thickness map to y, z, x. */
const FIN_AXES = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);

function surface(outline: Array<[number, number]>, thickness: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([span, along]) => new THREE.Vector2(span, along)));
  return new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false })
    .translate(0, 0, -thickness / 2)
    .applyMatrix4(FIN_AXES);
}

function band(from: number, to: number): THREE.LatheGeometry {
  return lathe([
    [RADIUS * 1.003, from],
    [RADIUS * 1.003, to],
  ]);
}

export interface Aim9Materials {
  body: THREE.Material;
  guidance: THREE.Material;
  dome: THREE.Material;
  window: THREE.Material;
  warheadBand: THREE.Material;
  motorBand: THREE.Material;
  nozzle: THREE.Material;
}

export function aim9Materials(): Aim9Materials {
  return {
    body: new THREE.MeshStandardMaterial({ color: 0xd4d6d0, roughness: 0.5, metalness: 0.25 }),
    guidance: new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.45, metalness: 0.35 }),
    dome: new THREE.MeshStandardMaterial({ color: 0x1d2228, roughness: 0.05, metalness: 0.7 }),
    window: new THREE.MeshStandardMaterial({ color: 0x3a4550, roughness: 0.1, metalness: 0.7 }),
    warheadBand: new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.6 }),
    motorBand: new THREE.MeshStandardMaterial({ color: 0x6f4a2a, roughness: 0.7 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8, metalness: 0.4 }),
  };
}

export function createAim9(materials: Aim9Materials): THREE.Group {
  const missile = new THREE.Group();
  missile.name = "AIM-9M";

  // Seeker dome: a hemisphere the full width of the body.
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 0.985, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2),
    materials.dome,
  );
  dome.position.z = NOSE - RADIUS;
  missile.add(dome);

  // Guidance and control: dark, with a thin retaining ring behind the dome.
  missile.add(new THREE.Mesh(lathe([[RADIUS, NOSE - RADIUS], [RADIUS, GUIDANCE_END]]), materials.guidance));
  missile.add(new THREE.Mesh(band(NOSE - RADIUS - 0.004, NOSE - RADIUS - 0.018), materials.body));

  // DSU-15 fuze: a ring of small windows looking out sideways.
  missile.add(new THREE.Mesh(lathe([[RADIUS, GUIDANCE_END], [RADIUS, FUZE_END]]), materials.body));
  const pane = new THREE.BoxGeometry(0.018, 0.004, 0.03);
  for (let index = 0; index < 8; index += 1) {
    const angle = (index * Math.PI) / 4 + Math.PI / 8;
    const window = new THREE.Mesh(pane, materials.window);
    window.position.set(Math.cos(angle) * RADIUS, Math.sin(angle) * RADIUS, (GUIDANCE_END + FUZE_END) / 2);
    window.rotation.z = angle - Math.PI / 2;
    missile.add(window);
  }

  // Warhead with its yellow band, then the motor with its brown one.
  missile.add(new THREE.Mesh(lathe([[RADIUS, FUZE_END], [RADIUS, TAIL + 0.03]]), materials.body));
  missile.add(new THREE.Mesh(band(FUZE_END - 0.02, FUZE_END - 0.075), materials.warheadBand));
  missile.add(new THREE.Mesh(band(WARHEAD_END - 0.03, WARHEAD_END - 0.085), materials.motorBand));

  // Nozzle: the body closes in a little and ends in a dark exit.
  missile.add(
    new THREE.Mesh(
      lathe([
        [RADIUS, TAIL + 0.03],
        [RADIUS * 0.9, TAIL],
        [RADIUS * 0.6, TAIL],
        [RADIUS * 0.55, TAIL + 0.04],
      ]),
      materials.nozzle,
    ),
  );

  // Launch lugs along the top, where the rail holds it.
  const lug = new THREE.BoxGeometry(0.03, 0.022, 0.05);
  for (const along of [NOSE - 0.95, -0.15, TAIL + 0.62]) {
    const hanger = new THREE.Mesh(lug, materials.body);
    hanger.position.set(0, RADIUS + 0.009, along);
    missile.add(hanger);
  }

  // Long-span pointed double-delta canards: a shallow strake off the root,
  // breaking to a steep delta that ends in a point near the trailing edge.
  const canard = surface(
    [
      [0, NOSE - CANARD.rootFront],
      [CANARD.strakeBreak.span, NOSE - CANARD.strakeBreak.along],
      [CANARD.tip.span, NOSE - CANARD.tip.along],
      [0, NOSE - CANARD.rootBack],
    ].map(([span, along]) => [span! + RADIUS - 0.004, along!] as [number, number]),
    0.006,
  );
  // Tail fins: swept leading edge, a tip parallel to the body, and a notch in
  // the aft corner where the rolleron sits.
  const notch = 0.055;
  const tailFin = surface(
    [
      [0, TAIL + FIN.rootFront],
      [FIN.span, TAIL + FIN.tipFront],
      [FIN.span, TAIL + FIN.rootBack + notch],
      [FIN.span - notch, TAIL + FIN.rootBack],
      [0, TAIL + FIN.rootBack],
    ].map(([span, along]) => [span! + RADIUS - 0.004, along!] as [number, number]),
    0.008,
  );
  const rolleron = new THREE.CylinderGeometry(0.038, 0.038, 0.014, 20).rotateZ(Math.PI / 2);

  // X configuration, as carried on the wingtip.
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const station = new THREE.Group();
    station.rotation.z = Math.PI / 4 + (quarter * Math.PI) / 2;
    station.add(new THREE.Mesh(canard, materials.body));
    station.add(new THREE.Mesh(tailFin, materials.body));
    const wheel = new THREE.Mesh(rolleron, materials.body);
    wheel.position.set(0, RADIUS + FIN.span - notch * 0.75, TAIL + FIN.rootBack + notch * 0.75);
    station.add(wheel);
    missile.add(station);
  }
  return missile;
}
