import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TERRAIN_EXTENT_M, terrainHeight } from "./sim/terrain";
import type { MatchState } from "./sim/types";

/**
 * What the renderer needs to draw a moment of a match.
 *
 * Live play and replay playback both produce this, so there is one renderer
 * rather than two that drift apart.
 */
export interface ViewerAircraft {
  id: string;
  team: "blue" | "red";
  position: [number, number, number];
  orientation: [number, number, number, number];
  alive: boolean;
}

export interface ViewerTracer {
  p: [number, number, number];
  /** Direction of travel. Absent in replays, which store positions only. */
  d?: [number, number, number];
}

export interface ViewerSnapshot {
  aircraft: ViewerAircraft[];
  tracers: ViewerTracer[];
}

export function snapshotFromMatch(state: MatchState): ViewerSnapshot {
  return {
    aircraft: state.aircraft.map((aircraft) => ({
      id: aircraft.id,
      team: aircraft.team,
      position: aircraft.position.toArray() as [number, number, number],
      orientation: aircraft.orientation.toArray() as [number, number, number, number],
      alive: aircraft.alive,
    })),
    tracers: state.projectiles.slice(-400).map((shot) => ({
      p: shot.position.toArray() as [number, number, number],
      d: shot.velocity.clone().normalize().toArray() as [number, number, number],
    })),
  };
}

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 80_000);
  readonly controls: OrbitControls;
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  private readonly projectileGroup = new THREE.Group();
  private modelTemplate?: THREE.Object3D;
  private followId = "blue-1";
  private readonly tracerMaterial = new THREE.LineBasicMaterial({
    color: 0xffd66b,
    transparent: true,
    opacity: 0.9,
  });
  private cameraInitialized = false;

  private readonly onResize = () => this.resize();

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 240;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI - 0.08;
    this.controls.rotateSpeed = 0.65;
    this.controls.zoomSpeed = 0.9;

    this.scene.background = new THREE.Color(0x9ec8e0);
    this.scene.fog = new THREE.FogExp2(0xa8c7d3, 0.000025);
    this.scene.add(new THREE.HemisphereLight(0xd7efff, 0x57482f, 2.1));
    const sun = new THREE.DirectionalLight(0xfff3d7, 3.2);
    sun.position.set(-8_000, 12_000, -3_000);
    this.scene.add(sun);
    this.scene.add(this.projectileGroup);
    this.createTerrain();
    this.resize();
    addEventListener("resize", this.onResize);
  }

  async loadAircraft(url = "/F16_Clean.glb"): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.modelTemplate = gltf.scene;
  }

  setFollow(id: string): void {
    this.followId = id;
    this.cameraInitialized = false;
  }

  private createTerrain(): void {
    // The mesh samples the same height field the simulation collides against,
    // so what the viewer draws as ground is exactly what the physics treats as
    // ground.
    const segments = 220;
    const geometry = new THREE.PlaneGeometry(TERRAIN_EXTENT_M, TERRAIN_EXTENT_M, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    if (positions) {
      for (let i = 0; i < positions.count; i++) {
        positions.setY(i, terrainHeight(positions.getX(i), positions.getZ(i)));
      }
    }
    geometry.computeVertexNormals();
    const terrain = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0x6e7350, roughness: 1, metalness: 0 }),
    );
    this.scene.add(terrain);

    const grid = new THREE.GridHelper(TERRAIN_EXTENT_M, 80, 0x6b684c, 0x7c7857);
    grid.position.y = 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.28;
    this.scene.add(grid);
  }

  private ensureAircraft(snapshot: ViewerSnapshot): void {
    if (!this.modelTemplate) return;
    for (const aircraft of snapshot.aircraft) {
      if (this.aircraftMeshes.has(aircraft.id)) continue;
      const mesh = this.modelTemplate.clone(true);
      mesh.name = aircraft.id;
      mesh.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.frustumCulled = true;
        if (aircraft.team === "red") {
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          if (material && "color" in material) {
            object.material = material.clone();
            (object.material as THREE.MeshStandardMaterial).color.multiply(new THREE.Color(1.15, 0.72, 0.68));
          }
        }
      });
      this.aircraftMeshes.set(aircraft.id, mesh);
      this.scene.add(mesh);
    }
  }

  render(snapshot: ViewerSnapshot): void {
    this.ensureAircraft(snapshot);
    for (const aircraft of snapshot.aircraft) {
      const mesh = this.aircraftMeshes.get(aircraft.id);
      if (!mesh) continue;
      mesh.position.fromArray(aircraft.position);
      mesh.quaternion.fromArray(aircraft.orientation);
      mesh.visible = aircraft.alive;
    }

    this.projectileGroup.clear();
    for (const tracer of snapshot.tracers) {
      const head = new THREE.Vector3().fromArray(tracer.p);
      const tail = tracer.d
        ? head.clone().addScaledVector(new THREE.Vector3().fromArray(tracer.d), -26)
        : head.clone().addScaledVector(new THREE.Vector3(0, 1, 0), -3);
      this.projectileGroup.add(
        new THREE.Line(new THREE.BufferGeometry().setFromPoints([tail, head]), this.tracerMaterial),
      );
    }

    const follow =
      snapshot.aircraft.find((aircraft) => aircraft.id === this.followId) ?? snapshot.aircraft[0];
    if (follow) {
      const followMesh = this.aircraftMeshes.get(follow.id);
      const target = followMesh
        ? new THREE.Box3().setFromObject(followMesh).getCenter(new THREE.Vector3())
        : new THREE.Vector3().fromArray(follow.position);
      if (!this.cameraInitialized) {
        const orientation = new THREE.Quaternion().fromArray(follow.orientation);
        const initialOffset = new THREE.Vector3(18, 8, -32).applyQuaternion(orientation);
        this.camera.position.copy(target).add(initialOffset);
        this.controls.target.copy(target);
        this.camera.up.set(0, 1, 0);
        this.cameraInitialized = true;
      } else {
        // Follow translation without overwriting the player's orbit angle.
        const movement = target.clone().sub(this.controls.target);
        this.camera.position.add(movement);
        this.controls.target.copy(target);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  getFollowFraming(): { x: number; y: number; minX: number; maxX: number; minY: number; maxY: number } | undefined {
    const mesh = this.aircraftMeshes.get(this.followId);
    if (!mesh) return undefined;
    mesh.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const projected = new THREE.Vector3();
    mesh.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const positions = object.geometry.attributes.position;
      if (!positions) return;
      for (let index = 0; index < positions.count; index++) {
        projected.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld).project(this.camera);
        minX = Math.min(minX, projected.x);
        maxX = Math.max(maxX, projected.x);
        minY = Math.min(minY, projected.y);
        maxY = Math.max(maxY, projected.y);
      }
    });
    if (!Number.isFinite(minX)) return undefined;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    return {
      x: (centerX + 1) / 2,
      y: (1 - centerY) / 2,
      minX: (minX + 1) / 2,
      maxX: (maxX + 1) / 2,
      minY: (1 - maxY) / 2,
      maxY: (1 - minY) / 2,
    };
  }

  /** Releases GPU resources; React unmounts this component on navigation. */
  dispose(): void {
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
}
