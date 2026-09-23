import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOZZLE } from "../src/sim/config";
import { AIRFRAMES } from "../src/sim/airframes";

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

  it("carries its missiles on the model's own wingtip mounts", () => {
    for (const [rail, name] of [
      [hornet.rails[0]!, "Mount_Wingtip_L"],
      [hornet.rails[1]!, "Mount_Wingtip_R"],
    ] as const) {
      const mount = node(name);
      expect(mount, `${name} should still be in the file`).toBeDefined();
      expect(-rail[0] * facing).toBeCloseTo(mount![0], 1);
      expect(rail[1]).toBeCloseTo(mount![1], 1);
      expect(rail[2] * facing).toBeCloseTo(mount![2], 1);
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
    }
  });
});
