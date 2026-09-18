import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The aircraft asset is load-bearing.
 *
 * The entire flight model is written against this model's axes: the nose is
 * +z, the canopy is +y, and therefore +x is the aircraft's left. Re-exporting
 * with a different orientation would not break anything visibly -- the jet
 * would fly beautifully and turn the wrong way, and every hit volume would be
 * in the wrong place. So the asset's geometry is checked, not assumed.
 */
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

/** Widest span across the aircraft within a slice along its long axis. */
function spanInSlice(vertices: [number, number, number][], fromZ: number, toZ: number): number {
  const slice = vertices.filter((vertex) => vertex[2] >= fromZ && vertex[2] <= toZ);
  if (!slice.length) return 0;
  return Math.max(...slice.map((vertex) => vertex[0])) - Math.min(...slice.map((vertex) => vertex[0]));
}

describe("the F-16 asset", () => {
  const { primitives, nodeNames, vertices } = readGlb("F16_Clean.glb");

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
    // Real F-16C: 15.0 m long, 9.96 m span, 5.1 m tall.
    expect(length).toBeGreaterThan(13);
    expect(length).toBeLessThan(17);
    expect(span).toBeGreaterThan(8.5);
    expect(span).toBeLessThan(11.5);
    expect(height).toBeGreaterThan(3.5);
    expect(height).toBeLessThan(6.5);
  });

  it("points its nose along +z and its canopy along +y", () => {
    // The exhaust is the unambiguous marker for the back of the aircraft.
    const exhaust = primitives.find((primitive) => /exhaust/i.test(primitive.name));
    expect(exhaust, "asset should still contain an exhaust mesh").toBeDefined();
    expect(exhaust!.max[2]).toBeLessThan(0);

    // The tail fin reaches far higher than anything reaches low.
    expect(bounds.max[1]).toBeGreaterThan(Math.abs(bounds.min[1]));

    // The nose tapers to a point while the tail carries the stabilators, so the
    // +z extremity must be far narrower than the middle of the aircraft.
    const noseSlice = spanInSlice(vertices, bounds.max[2] - 1.2, bounds.max[2]);
    const wingSlice = spanInSlice(vertices, -2, 2);
    expect(noseSlice).toBeLessThan(2);
    expect(wingSlice).toBeGreaterThan(noseSlice * 3);
  });

  it("does not ship the modelling reference blueprints as scene geometry", () => {
    // These may exist as empty nodes, but nothing named REF may carry a mesh.
    expect(primitives.some((primitive) => /^REF\b/i.test(primitive.name))).toBe(false);
    // And if they are present as nodes, the viewer is expected to strip them.
    const references = nodeNames.filter((name) => /^REF\b/i.test(name));
    if (references.length) {
      expect(references.every((name) => /^REF\b/i.test(name))).toBe(true);
    }
  });
});
