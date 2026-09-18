import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MatchState } from "./sim/types";

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 80_000);
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  private readonly projectileGroup = new THREE.Group();
  private readonly clock = new THREE.Clock();
  private modelTemplate?: THREE.Object3D;
  private followId = "blue-1";

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);

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
  }

  setFollow(id: string): void { this.followId = id; }

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
    const dt = Math.min(this.clock.getDelta(), 0.05);
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
      const desired = new THREE.Vector3(0, 3.2, -22).applyQuaternion(follow.orientation).add(follow.position);
      const target = new THREE.Vector3(0, 1, 35).applyQuaternion(follow.orientation).add(follow.position);
      this.camera.position.lerp(desired, 1 - Math.exp(-dt * 5));
      const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(follow.orientation);
      this.camera.up.lerp(cameraUp, 1 - Math.exp(-dt * 3)).normalize();
      this.camera.lookAt(target);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
}
