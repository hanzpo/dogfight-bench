import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_CHUNKS,
  TERRAIN_CHUNK_SEGMENTS,
  TERRAIN_EXTENT_M,
  terrainElevation,
  terrainHeight,
} from "../src/sim/terrain";

function buildGround(chunks: Array<[number, number]>): THREE.Object3D[] {
  const chunkExtent = TERRAIN_EXTENT_M / TERRAIN_CHUNKS;
  return chunks.map(([row, column]) => {
    const centreX = (column + 0.5) * chunkExtent - TERRAIN_EXTENT_M / 2;
    const centreZ = (row + 0.5) * chunkExtent - TERRAIN_EXTENT_M / 2;
    const geometry = new THREE.PlaneGeometry(
      chunkExtent,
      chunkExtent,
      TERRAIN_CHUNK_SEGMENTS,
      TERRAIN_CHUNK_SEGMENTS,
    )
      .rotateX(-Math.PI / 2)
      .translate(centreX, 0, centreZ);
    const positions = geometry.attributes["position"]!;
    for (let index = 0; index < positions.count; index += 1) {
      positions.setY(index, terrainElevation(positions.getX(index), positions.getZ(index)));
    }
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return mesh;
  });
}

describe("the terrain collider", () => {
  it("collides with exactly the surface the viewer draws", () => {
    const ground = buildGround([
      [3, 3],
      [3, 4],
      [4, 3],
      [4, 4],
    ]);
    const raycaster = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const random = mulberry(20_260_918);

    let worst = 0;
    let checked = 0;
    for (let sample = 0; sample < 4_000; sample += 1) {
      const x = (random() * 2 - 1) * 9_000;
      const z = (random() * 2 - 1) * 9_000;
      raycaster.set(new THREE.Vector3(x, 12_000, z), down);
      const hit = raycaster.intersectObjects(ground, false)[0];
      if (!hit) continue;
      checked += 1;
      worst = Math.max(worst, Math.abs(terrainHeight(x, z) - Math.max(hit.point.y, 0)));
    }

    expect(checked).toBeGreaterThan(3_500);
    expect(worst).toBeLessThan(0.01);
  });

  it("agrees with the height field at the grid vertices themselves", () => {
    const step = TERRAIN_EXTENT_M / (TERRAIN_CHUNKS * TERRAIN_CHUNK_SEGMENTS);
    const half = TERRAIN_EXTENT_M / 2;
    for (const index of [100, 137, 152, 190]) {
      const x = index * step - half;
      const z = (index + 11) * step - half;
      expect(terrainHeight(x, z)).toBeCloseTo(Math.max(terrainElevation(x, z), 0), 6);
    }
  });
});

function mulberry(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
