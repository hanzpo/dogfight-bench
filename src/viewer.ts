import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MatchState } from "./sim/types";

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 80_000);
  readonly controls: OrbitControls;
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  private readonly projectileGroup = new THREE.Group();
  private modelTemplate?: THREE.Object3D;
  private readonly modelCenter = new THREE.Vector3();
  private followId = "blue-1";
  private cameraInitialized = false;
  private readonly framingOffset = new THREE.Vector3();

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
    addEventListener("resize", () => this.resize());
  }

  async loadAircraft(url = "/F16_Clean.glb"): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.modelTemplate = gltf.scene;
    new THREE.Box3().setFromObject(gltf.scene).getCenter(this.modelCenter);
  }

  setFollow(id: string): void {
    this.followId = id;
    this.cameraInitialized = false;
    this.framingOffset.set(0, 0, 0);
  }

  private createTerrain(): void {
    const size = 80_000;
    const segments = 100;
    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    if (positions) {
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getZ(i);
        const edge = Math.min(1, Math.hypot(x, z) / 5_000);
        const hills = (Math.sin(x / 2_900) * Math.cos(z / 3_700) * 170
          + Math.sin((x + z) / 1_450) * 55) * edge;
        positions.setY(i, Math.max(-20, hills));
      }
    }
    geometry.computeVertexNormals();
    const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x6e7350, roughness: 1, metalness: 0,
    }));
    this.scene.add(terrain);

    const grid = new THREE.GridHelper(size, 80, 0x6b684c, 0x7c7857);
    grid.position.y = 2;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.28;
    this.scene.add(grid);
  }

  private ensureAircraft(state: MatchState): void {
    if (!this.modelTemplate) return;
    for (const aircraft of state.aircraft) {
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

  render(state: MatchState): void {
    this.ensureAircraft(state);
    for (const aircraft of state.aircraft) {
      const mesh = this.aircraftMeshes.get(aircraft.id);
      if (!mesh) continue;
      mesh.position.copy(aircraft.position);
      mesh.quaternion.copy(aircraft.orientation);
      mesh.visible = aircraft.alive;
    }

    this.projectileGroup.clear();
    const material = new THREE.LineBasicMaterial({ color: 0xffd66b, transparent: true, opacity: 0.9 });
    for (const p of state.projectiles.slice(-350)) {
      const back = p.velocity.clone().normalize().multiplyScalar(-22).add(p.position);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([back, p.position]), material);
      this.projectileGroup.add(line);
    }

    const follow = state.aircraft.find((a) => a.id === this.followId) ?? state.aircraft[0];
    if (follow) {
      // The mesh origin sits forward of its visual center. Orbit around the
      // rendered model's center so the aircraft—not its origin—stays framed.
      const target = this.modelCenter.clone().applyQuaternion(follow.orientation).add(follow.position).add(this.framingOffset);
      if (!this.cameraInitialized) {
        const initialOffset = new THREE.Vector3(18, 8, -32).applyQuaternion(follow.orientation);
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
    this.centerProjectedAircraft();
    this.renderer.render(this.scene, this.camera);
  }

  private centerProjectedAircraft(): void {
    const framing = this.getFollowFraming();
    if (!framing) return;
    const ndcX = framing.x * 2 - 1;
    const ndcY = 1 - framing.y * 2;
    if (Math.abs(ndcX) < 0.001 && Math.abs(ndcY) < 0.001) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * distance;
    const visibleWidth = visibleHeight * this.camera.aspect;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const correction = right.multiplyScalar(ndcX * visibleWidth / 2).add(up.multiplyScalar(ndcY * visibleHeight / 2));
    this.camera.position.add(correction);
    this.controls.target.add(correction);
    this.framingOffset.add(correction);
    this.camera.updateMatrixWorld(true);
  }

  getFollowFraming(): { x: number; y: number } | undefined {
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
    return { x: (centerX + 1) / 2, y: (1 - centerY) / 2 };
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
}
