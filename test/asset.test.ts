import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOZZLE } from "../src/sim/config";
import { AIRFRAMES, fromModel, type Airframe } from "../src/sim/airframes";
import { hitVolumesFor } from "../src/sim/damage";

interface Primitive {
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

function readGlb(path: string): { primitives: Primitive[]; nodeNames: string[]; vertices: [number, number, number][] } {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as {
    meshes: Array<{ name?: string; primitives: Array<{ attributes: { POSITION: number } }> }>;
    accessors: Array<{ min: number[]; max: number[]; bufferView: number; byteOffset?: number; count: number }>;
    bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
    nodes: Array<{ name?: string }>;
  };
  const binaryStart = 20 + jsonLength + 8;

  const primitives: Primitive[] = [];
  const vertices: [number, number, number][] = [];
  for (const mesh of gltf.meshes) {
    for (const primitive of mesh.primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION]!;
      primitives.push({
        name: mesh.name ?? "",
        min: accessor.min as [number, number, number],
        max: accessor.max as [number, number, number],
      });

      const view = gltf.bufferViews[accessor.bufferView]!;
      const offset = binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = view.byteStride ?? 12;
      for (let index = 0; index < accessor.count; index += 1) {
        const at = offset + index * stride;
        vertices.push([buffer.readFloatLE(at), buffer.readFloatLE(at + 4), buffer.readFloatLE(at + 8)]);
      }
    }
  }
  return { primitives, nodeNames: gltf.nodes.map((node) => node.name ?? ""), vertices };
}

function spanInSlice(vertices: [number, number, number][], fromZ: number, toZ: number): number {
  const slice = vertices.filter((vertex) => vertex[2] >= fromZ && vertex[2] <= toZ);
  if (!slice.length) return 0;
  return Math.max(...slice.map((vertex) => vertex[0])) - Math.min(...slice.map((vertex) => vertex[0]));
}

describe("the F-16 asset", () => {
  const { primitives, nodeNames, vertices } = readGlb("public/F16_Clean.glb");

  const bounds = primitives.reduce(
    (box, primitive) => ({
      min: box.min.map((value, axis) => Math.min(value, primitive.min[axis]!)) as [number, number, number],
      max: box.max.map((value, axis) => Math.max(value, primitive.max[axis]!)) as [number, number, number],
    }),
    { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] },
  );

  it("is an F-16 sized aircraft in metres", () => {
    const length = bounds.max[2] - bounds.min[2];
    const span = bounds.max[0] - bounds.min[0];
    const height = bounds.max[1] - bounds.min[1];
    expect(length).toBeGreaterThan(13);
    expect(length).toBeLessThan(17);
    expect(span).toBeGreaterThan(8.5);
    expect(span).toBeLessThan(11.5);
    expect(height).toBeGreaterThan(3.5);
    expect(height).toBeLessThan(6.5);
  });

  it("points its nose along +z and its canopy along +y", () => {
    const exhaust = primitives.find((primitive) => /exhaust/i.test(primitive.name));
    expect(exhaust, "asset should still contain an exhaust mesh").toBeDefined();
    expect(exhaust!.max[2]).toBeLessThan(0);

    expect(bounds.max[1]).toBeGreaterThan(Math.abs(bounds.min[1]));

    const noseSlice = spanInSlice(vertices, bounds.max[2] - 1.2, bounds.max[2]);
    const wingSlice = spanInSlice(vertices, -2, 2);
    expect(noseSlice).toBeLessThan(2);
    expect(wingSlice).toBeGreaterThan(noseSlice * 3);
  });

  it("does not ship the modelling reference blueprints as scene geometry", () => {
    expect(primitives.some((primitive) => /^REF\b/i.test(primitive.name))).toBe(false);
    const references = nodeNames.filter((name) => /^REF\b/i.test(name));
    if (references.length) {
      expect(references.every((name) => /^REF\b/i.test(name))).toBe(true);
    }
  });

  it("has its engine nozzle where the afterburner plume is drawn", () => {
    const core = vertices.filter((vertex) => Math.hypot(vertex[0], vertex[1] - NOZZLE.centreYM) < 0.9);
    const exitZ = Math.min(...core.map((vertex) => vertex[2]));
    const ring = core.filter((vertex) => vertex[2] < exitZ + 0.05);
    const xs = ring.map((vertex) => vertex[0]);
    const ys = ring.map((vertex) => vertex[1]);
    const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const radius = ring.reduce(
      (widest, vertex) => Math.max(widest, Math.hypot(vertex[0] - centreX, vertex[1] - centreY)),
      0,
    );

    expect(exitZ).toBeCloseTo(NOZZLE.exitZM, 1);
    expect(centreX).toBeCloseTo(0, 2);
    expect(centreY).toBeCloseTo(NOZZLE.centreYM, 2);
    expect(radius).toBeCloseTo(NOZZLE.exitRadiusM, 1);
  });
});

describe("the F/A-18 asset", () => {
  const hornet = AIRFRAMES.fa18c;
  const { primitives, vertices } = readGlb(`public${hornet.model}`);
  const gltf = (() => {
    const buffer = readFileSync(`public${hornet.model}`);
    const length = buffer.readUInt32LE(12);
    return JSON.parse(buffer.subarray(20, 20 + length).toString("utf8")) as {
      nodes: Array<{ name?: string; translation?: [number, number, number] }>;
    };
  })();
  const node = (name: string) => gltf.nodes.find((candidate) => candidate.name === name)?.translation;
  // Model space has +x to the left; turning the file by 180° flips x and z
  // again. So a point in the file is (-right × facing, up, nose × facing).
  const facing = hornet.modelYawDeg === 180 ? -1 : 1;

  const zs = vertices.map((vertex) => vertex[2]);
  const xs = vertices.map((vertex) => vertex[0]);

  it("is a Hornet-sized aircraft in metres", () => {
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(15.5);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(18);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(12.8);
  });

  it("is turned so its nose ends up along +z", () => {
    // Its radome is the only warm-grey part; wherever the file put it, the
    // turn has to bring it forward.
    const radome = primitives.find((primitive) => primitive.min[2] < -6 && primitive.max[2] < -6)
      ?? primitives.find((primitive) => primitive.min[2] > 6 && primitive.max[2] > 6);
    expect(radome).toBeDefined();
    const noseInFile = (radome!.min[2] + radome!.max[2]) / 2;
    expect(noseInFile * facing).toBeGreaterThan(6);
  });

  it("carries its missiles beside its wingtip rails, not through them", () => {
    const radius = 0.0635;
    for (const [rail, name] of [
      [hornet.rails[0]!, "Mount_Wingtip_L"],
      [hornet.rails[1]!, "Mount_Wingtip_R"],
    ] as const) {
      const mount = node(name);
      expect(mount, `${name} should still be in the file`).toBeDefined();
      // Level with the rail and along it, beside the mount point.
      const x = -rail[0] * facing;
      const z = rail[2] * facing;
      expect(Math.abs(x - mount![0])).toBeLessThan(0.3);
      expect(Math.abs(rail[1] - mount![1])).toBeLessThan(0.15);
      // Nothing of the airframe inside the missile's body, anywhere along it.
      const inside = vertices.filter(
        (vertex) =>
          Math.abs(vertex[2] - z) < 1.425 && Math.hypot(vertex[0] - x, vertex[1] - rail[1]) < radius,
      );
      expect(inside, `${name}: airframe inside the missile`).toHaveLength(0);
      // And outboard of the rail: the tip of the wing is inboard of the missile's inner side.
      const tip = Math.max(...vertices.filter((vertex) => Math.sign(vertex[0]) === Math.sign(x)).map((vertex) => Math.abs(vertex[0])));
      expect(Math.abs(x) - radius).toBeGreaterThanOrEqual(tip - 1e-3);
    }
  });

  it("has its nozzles where the afterburner plumes are drawn", () => {
    for (const [right, up, nose] of hornet.nozzles) {
      const x = -right * facing;
      const z = nose * facing;
      const near = vertices.filter(
        (vertex) => Math.hypot(vertex[0] - x, vertex[1] - up) < hornet.nozzleRadiusM + 0.1 && Math.abs(vertex[2] - z) < 0.2,
      );
      expect(near.length, `a nozzle ring at (${x}, ${up}, ${z}) in the file`).toBeGreaterThan(8);
      // The plume starts the size of the opening: the innermost ring at the exit.
      const opening = Math.min(...near.map((vertex) => Math.hypot(vertex[0] - x, vertex[1] - up)));
      expect(hornet.nozzleRadiusM).toBeCloseTo(opening, 1);
    }
  });
});

type Point = [number, number, number];

/**
 * Every vertex and triangle of a model in body axes -- right, up, nose -- as
 * the airframe says to read it: the file turned by its yaw.
 */
function modelMesh(frame: Airframe): { vertices: Point[]; triangles: [number, number, number][] } {
  const facing = frame.modelYawDeg === 180 ? -1 : 1;
  const buffer = readFileSync(`public${frame.model}`);
  const jsonLength = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as {
    scenes: Array<{ nodes: number[] }>;
    nodes: Array<{ mesh?: number; translation?: [number, number, number]; children?: number[] }>;
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number }; indices?: number }> }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; count: number; componentType: number }>;
    bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  };
  const start = 20 + jsonLength + 8;
  const vertices: Point[] = [];
  const triangles: [number, number, number][] = [];
  const visit = (index: number, at: Point) => {
    const node = gltf.nodes[index]!;
    const t = node.translation ?? [0, 0, 0];
    const here: Point = [at[0] + t[0], at[1] + t[1], at[2] + t[2]];
    for (const primitive of node.mesh === undefined ? [] : gltf.meshes[node.mesh]!.primitives) {
      const first = vertices.length;
      const accessor = gltf.accessors[primitive.attributes.POSITION]!;
      const view = gltf.bufferViews[accessor.bufferView]!;
      const offset = start + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = view.byteStride ?? 12;
      for (let i = 0; i < accessor.count; i += 1) {
        const x = buffer.readFloatLE(offset + i * stride) + here[0];
        const y = buffer.readFloatLE(offset + i * stride + 4) + here[1];
        const z = buffer.readFloatLE(offset + i * stride + 8) + here[2];
        // Model +x is left, so right is -x; the yaw flips x and z together.
        vertices.push([-x * facing, y, z * facing]);
      }
      if (primitive.indices === undefined) continue;
      const indices = gltf.accessors[primitive.indices]!;
      const indexView = gltf.bufferViews[indices.bufferView]!;
      const indexOffset = start + (indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0);
      const wide = indices.componentType === 5125;
      const read = (i: number) => (wide ? buffer.readUInt32LE(indexOffset + i * 4) : buffer.readUInt16LE(indexOffset + i * 2));
      for (let i = 0; i + 2 < indices.count; i += 3) triangles.push([first + read(i), first + read(i + 1), first + read(i + 2)]);
    }
    for (const child of node.children ?? []) visit(child, here);
  };
  for (const root of gltf.scenes[0]!.nodes) visit(root, [0, 0, 0]);
  return { vertices, triangles };
}

function modelVertices(frame: Airframe): Point[] {
  return modelMesh(frame).vertices;
}

/**
 * Where the surface crosses the plane where body axis `axis` equals `at`: a
 * low-poly wing may have no vertex between its root and its tip, but its
 * edges cross every station.
 */
function slice(mesh: ReturnType<typeof modelMesh>, at: number, axis: 0 | 1 | 2 = 0): Point[] {
  const out: Point[] = [];
  for (const triangle of mesh.triangles) {
    for (let k = 0; k < 3; k += 1) {
      const a = mesh.vertices[triangle[k]!]!;
      const b = mesh.vertices[triangle[(k + 1) % 3]!]!;
      if ((a[axis] - at) * (b[axis] - at) >= 0) continue;
      const f = (at - a[axis]) / (b[axis] - a[axis]);
      out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])]);
    }
  }
  return out;
}

describe.each([AIRFRAMES.f16c, AIRFRAMES.fa18c, AIRFRAMES.f15c, AIRFRAMES.mig29a, AIRFRAMES.f5e, AIRFRAMES.su27s, AIRFRAMES.m2000c, AIRFRAMES.jas39c])("the $name model, calibrated", (frame) => {
  const mesh = modelMesh(frame);
  const vertices = mesh.vertices;

  it("has its centre of gravity inside the wing's root chord", () => {
    // The inner wing panel, clear of the fuselage and its strakes, near the
    // wing's plane: its vertices, and where its surface crosses stations there.
    const stations = [1.5, 2, 2.5, 3, 3.5].flatMap((at) => [...slice(mesh, at), ...slice(mesh, -at)]);
    const root = [...vertices, ...stations].filter(
      (vertex) => Math.abs(vertex[0]) > 1.45 && Math.abs(vertex[0]) < 3.8 && Math.abs(vertex[1]) < 0.5,
    );
    const leading = Math.max(...root.map((vertex) => vertex[2]));
    const trailing = Math.min(...root.map((vertex) => vertex[2]));
    expect(frame.cg[2]).toBeLessThan(leading);
    expect(frame.cg[2]).toBeGreaterThan(trailing);
    // Forward half of it: a jet balanced behind its mid-chord would not fly.
    expect(frame.cg[2]).toBeGreaterThan((leading + trailing) / 2);
  });

  it("has every hit volume on the airframe, not in the air beside it", () => {
    for (const volume of hitVolumesFor(frame).volumes) {
      // Back onto the model: hit volumes are measured from the centre of gravity.
      const centre = [volume.offset[0] + frame.cg[0], volume.offset[1] + frame.cg[1], volume.offset[2] + frame.cg[2]];
      const touching = vertices.some(
        (vertex) => Math.hypot(vertex[0] - centre[0]!, vertex[1] - centre[1]!, vertex[2] - centre[2]!) < volume.radiusM,
      );
      expect(touching, `${volume.subsystem} at ${centre.map((value) => value.toFixed(1)).join(", ")}`).toBe(true);
    }
  });

  it("fires its gun from the skin of its nose", () => {
    const muzzle = frame.gun.muzzleOffsetM;
    const nearest = Math.min(
      ...vertices.map((vertex) => Math.hypot(vertex[0] - muzzle[0], vertex[1] - muzzle[1], vertex[2] - muzzle[2])),
    );
    expect(nearest).toBeLessThan(0.8);
    // And ahead of the centre of gravity, where a gun is.
    expect(fromModel(frame, muzzle)[2]).toBeGreaterThan(0);
  });

  it("keeps its nozzle mouths clear, so nothing shows inside them", () => {
    // Just inside each exit, the only surface near the axis is the nozzle's own wall.
    for (const [right, up, nose] of frame.nozzles) {
      const inside = slice(mesh, nose + 0.15, 2).filter(
        (point) => Math.hypot(point[0] - right, point[1] - up) < frame.nozzleRadiusM * 0.85,
      );
      expect(inside, `surface inside the nozzle at (${right}, ${up}, ${nose})`).toHaveLength(0);
    }
  });

  it("puts the pilot's eye inside the canopy", () => {
    const [right, up, nose] = frame.cockpitEye;
    const above = vertices.filter(
      (vertex) => Math.abs(vertex[0] - right) < 0.3 && Math.abs(vertex[2] - nose) < 0.4 && vertex[1] > up,
    );
    const below = vertices.filter(
      (vertex) => Math.abs(vertex[0] - right) < 0.3 && Math.abs(vertex[2] - nose) < 0.4 && vertex[1] < up,
    );
    expect(above.length, "canopy above the eye").toBeGreaterThan(0);
    expect(below.length, "fuselage below the eye").toBeGreaterThan(0);
  });
});

describe.each([AIRFRAMES.f15c, AIRFRAMES.mig29a, AIRFRAMES.f5e, AIRFRAMES.su27s, AIRFRAMES.m2000c, AIRFRAMES.jas39c])("the $name model's stores and nozzles", (frame) => {
  const vertices = modelVertices(frame);

  it("has its nozzles where the afterburner plumes are drawn, the size of the opening", () => {
    for (const [right, up, nose] of frame.nozzles) {
      const near = vertices.filter(
        (vertex) => Math.hypot(vertex[0] - right, vertex[1] - up) < frame.nozzleRadiusM + 0.1 && Math.abs(vertex[2] - nose) < 0.2,
      );
      expect(near.length, `a nozzle ring at (${right}, ${up}, ${nose})`).toBeGreaterThan(8);
      const opening = Math.min(...near.map((vertex) => Math.hypot(vertex[0] - right, vertex[1] - up)));
      expect(frame.nozzleRadiusM).toBeCloseTo(opening, 1);
    }
  });

  it("carries its missiles clear of the airframe, and a pylon reaches any under the wing", () => {
    const radius = 0.0635;
    for (const [right, up, nose] of frame.rails) {
      const inside = vertices.filter(
        (vertex) => Math.abs(vertex[2] - nose) < 1.425 && Math.hypot(vertex[0] - right, vertex[1] - up) < radius,
      );
      expect(inside, "airframe inside the missile").toHaveLength(0);
      if (frame.pylonHeightM === undefined) continue;
      // The wing is above the missile, within the pylon's height of its back.
      const above = vertices.filter(
        (vertex) => Math.abs(vertex[0] - right) < 0.6 && Math.abs(vertex[2] - nose) < 0.8 && vertex[1] > up,
      );
      const underside = Math.min(...above.map((vertex) => vertex[1]));
      expect(underside - (up + radius)).toBeGreaterThan(0);
      expect(underside - (up + radius)).toBeLessThanOrEqual(frame.pylonHeightM! + 0.02);
    }
  });
});
