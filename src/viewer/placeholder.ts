import * as THREE from "three";
import type { Airframe } from "../sim/airframes";

/**
 * A stand-in jet built from the airframe's numbers, until a real model is
 * dropped in at the airframe's `model` path.
 *
 * It is meant to be recognisable by silhouette and nothing more: a delta or
 * a swept wing, one fin or two, canards or none, and the nozzles where the
 * flight model puts the plumes. Model space matches the F-16's: nose along
 * +z, up +y, left +x, metres, origin in the middle of the length.
 */
export function buildPlaceholder(frame: Airframe): THREE.Group {
  const shape = frame.placeholder;
  const length = frame.geometry.lengthM;
  const half = length / 2;
  const radius = shape.fuselageRadiusM;
  const skin = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.7, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.1, metalness: 0.6 });
  const jet = new THREE.Group();
  jet.name = frame.id;

  // Fuselage: a lathed body, pointed at the nose and a little narrower at the tail.
  const profile = [
    [0.02, half],
    [radius * 0.45, half - length * 0.07],
    [radius * 0.85, half - length * 0.17],
    [radius, half - length * 0.28],
    [radius, -half + length * 0.12],
    [radius * 0.8, -half],
  ].reverse().map(([r, along]) => new THREE.Vector2(r!, along!));
  jet.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 16).rotateX(Math.PI / 2), skin));

  // Canopy: a flattened bubble over the pilot's eye.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(radius * 0.62, radius * 0.75, length * 0.09);
  canopy.position.set(0, frame.cockpitEye[1] * 0.55, frame.cockpitEye[2]);
  jet.add(canopy);

  // Wings: one planform, mirrored for the other side.
  const semiSpan = frame.geometry.wingSpanM / 2 - radius * 0.8;
  const rootLeading = half - shape.wingRootAt * length;
  const sweep = Math.tan((shape.wingSweepDeg * Math.PI) / 180);
  const tipLeading = rootLeading - sweep * semiSpan;
  const wing = planform([
    [0, rootLeading],
    [semiSpan, tipLeading],
    [semiSpan, tipLeading - shape.wingTipChordM],
    [0, rootLeading - shape.wingRootChordM],
  ]);
  addMirrored(jet, wing, skin, radius * 0.8, -radius * 0.25);

  if (shape.tailplane) {
    const span = frame.geometry.wingSpanM * 0.3;
    const lead = -half + length * 0.2;
    addMirrored(
      jet,
      planform([
        [0, lead],
        [span, lead - span * 0.7],
        [span, lead - span * 0.7 - 0.8],
        [0, lead - 2.2],
      ]),
      skin,
      radius * 0.7,
      -radius * 0.1,
    );
  }

  if (shape.canards) {
    const lead = frame.cockpitEye[2] - 1.0;
    addMirrored(
      jet,
      planform([
        [0, lead],
        [1.3, lead - 1.1],
        [1.3, lead - 1.5],
        [0, lead - 1.4],
      ]),
      skin,
      radius * 0.85,
      radius * 0.2,
    );
  }

  // Fins: upright for one, canted outward in pairs.
  const finLead = -half + length * 0.27;
  const fin = planform([
    [0, finLead],
    [shape.finHeightM, finLead - shape.finHeightM * 1.1],
    [shape.finHeightM, finLead - shape.finHeightM * 1.1 - 1.0],
    [0, -half + 0.6],
  ]);
  const offsets = shape.fins === 1 ? [0] : [-radius * 1.1, radius * 1.1];
  for (const offset of offsets) {
    const mesh = new THREE.Mesh(fin, skin);
    const cant = shape.fins === 1 ? 0 : Math.sign(offset) * ((shape.finCantDeg * Math.PI) / 180);
    mesh.rotation.z = Math.PI / 2 + cant;
    mesh.position.set(offset, radius * 0.7, 0);
    jet.add(mesh);
  }

  // Nozzles where the flight model says the plumes come out.
  for (const [right, up, nose] of frame.nozzles) {
    const nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(frame.nozzleRadiusM, frame.nozzleRadiusM * 1.1, 1.0, 16, 1, true).rotateX(Math.PI / 2),
      dark,
    );
    nozzle.position.set(-right, up, nose + 0.5);
    jet.add(nozzle);
    if (frame.nozzles.length > 1) {
      // A nacelle to carry each engine out to where its nozzle is.
      const nacelle = new THREE.Mesh(
        new THREE.CylinderGeometry(frame.nozzleRadiusM * 1.25, frame.nozzleRadiusM * 1.25, length * 0.45, 12).rotateX(
          Math.PI / 2,
        ),
        skin,
      );
      nacelle.position.set(-right, up, nose + 1 + length * 0.225);
      jet.add(nacelle);
    }
  }
  return jet;
}

/** A flat surface from its outline, (outward, along), a few centimetres thick, laid in the x-z plane. */
function planform(outline: Array<[number, number]>): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(outline.map(([out, along]) => new THREE.Vector2(out, along)));
  return new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false }).translate(0, 0, -0.04).rotateX(Math.PI / 2);
}

function addMirrored(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, out: number, up: number): void {
  for (const side of [1, -1]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.x = side;
    mesh.position.set(side * out, up, 0);
    parent.add(mesh);
  }
}
