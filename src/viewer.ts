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
  /** Lights the exhaust plume. */
  afterburner?: boolean;
  /** 1 is undamaged; below about 0.7 the jet starts trailing smoke. */
  integrity?: number;
}

export interface ViewerTracer {
  p: [number, number, number];
  /** Direction of travel. Absent in replays, which store positions only. */
  d?: [number, number, number];
}

export interface ViewerSnapshot {
  aircraft: ViewerAircraft[];
  tracers: ViewerTracer[];
  /** Impact points recorded since the previous snapshot. */
  impacts?: Array<[number, number, number]>;
  /** Simulated time, used to age effects independently of frame rate. */
  time: number;
}

/**
 * Pulls the aircraft out of whatever the modelling tool exported.
 *
 * A Blender file usually carries the reference blueprints the aircraft was
 * modelled against. They export as sibling nodes metres away from the airframe,
 * and anything that measures the model -- the camera's follow target, the
 * framing check -- would silently include them.
 */
export function extractAirframe(scene: THREE.Object3D): THREE.Object3D {
  const airframe = scene.getObjectByName("F16_Clean") ?? scene;
  for (const child of [...airframe.children]) {
    if (/^REF\b/i.test(child.name)) airframe.remove(child);
  }
  return airframe;
}

export function snapshotFromMatch(state: MatchState, sinceEventIndex = state.events.length): ViewerSnapshot {
  const byId = new Map(state.aircraft.map((aircraft) => [aircraft.id, aircraft]));
  const impacts: Array<[number, number, number]> = [];
  for (const event of state.events.slice(sinceEventIndex)) {
    if (event.type !== "hit" && event.type !== "kill" && event.type !== "ground-impact") continue;
    const target = byId.get(event.targetId ?? event.actorId ?? "");
    if (target) impacts.push(target.position.toArray() as [number, number, number]);
  }
  return {
    time: state.time,
    aircraft: state.aircraft.map((aircraft) => ({
      id: aircraft.id,
      team: aircraft.team,
      position: aircraft.position.toArray() as [number, number, number],
      orientation: aircraft.orientation.toArray() as [number, number, number, number],
      alive: aircraft.alive,
      afterburner: aircraft.engine.afterburner,
      integrity: aircraft.damage.integrity,
    })),
    tracers: state.projectiles.slice(-400).map((shot) => ({
      p: shot.position.toArray() as [number, number, number],
      d: shot.velocity.clone().normalize().toArray() as [number, number, number],
    })),
    impacts,
  };
}

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 80_000);
  readonly controls: OrbitControls;
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  private readonly projectileGroup = new THREE.Group();
  private readonly effectGroup = new THREE.Group();
  private sky?: THREE.Mesh;
  private readonly plumes = new Map<string, THREE.Mesh>();
  private readonly effects: Array<{ mesh: THREE.Mesh; born: number; life: number; grow: number }> = [];
  private lastEffectTime = 0;
  private modelTemplate?: THREE.Object3D;
  private followId = "blue-1";
  private readonly tracerMaterial = new THREE.LineBasicMaterial({
    color: 0xffd06a,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly plumeMaterial = new THREE.MeshBasicMaterial({
    color: 0x7fc4ff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly sparkMaterial = new THREE.MeshBasicMaterial({
    color: 0xffb257,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly smokeMaterial = new THREE.MeshBasicMaterial({
    color: 0x2b2b2b,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });
  private cameraInitialized = false;

  private readonly onResize = () => this.resize();
  private resizeObserver?: ResizeObserver;
  private pixelRatioQuery?: MediaQueryList;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      // The scene spans eighty kilometres and the aircraft is fifteen metres
      // long; without a logarithmic depth buffer the model z-fights itself.
      logarithmicDepthBuffer: true,
    });
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

    this.scene.fog = new THREE.FogExp2(0x9fbdd0, 0.0000115);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5a3a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d0, 3.0);
    sun.position.set(-9_000, 11_000, 6_000);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x9ab2c4, 0.8));
    this.scene.add(this.projectileGroup);
    this.scene.add(this.effectGroup);
    this.createSky();
    this.createTerrain();
    this.resize();
    addEventListener("resize", this.onResize);

    // Sizing once at construction is not enough. WebKit lays the canvas out at
    // its default 300x150 if it is measured before styles have settled, and
    // never corrects it, which puts the render off-centre on Safari while
    // Chromium looks fine. Observing the element covers late styles, layout
    // shifts and anything else an engine does differently.
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    this.watchPixelRatio();

    // A browser may take the WebGL context away at any time -- Safari does it
    // under memory pressure or when a tab is backgrounded. Calling
    // preventDefault is what allows the browser to hand it back; without it the
    // canvas stays blank for good. three re-uploads its own resources on
    // restore, so nothing else has to be rebuilt.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  async loadAircraft(url = "/F16_Clean.glb"): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    this.modelTemplate = extractAirframe(gltf.scene);
  }

  setFollow(id: string): void {
    this.followId = id;
    this.cameraInitialized = false;
  }

  /**
   * Gradient sky dome.
   *
   * A flat background colour makes altitude unreadable: at nine kilometres the
   * horizon should be visibly below you and the zenith visibly darker. The dome
   * is drawn on the inside of a sphere with depth writing off, so it never
   * interacts with anything in the scene.
   *
   * It is deliberately smaller than the camera's far plane and re-centred on
   * the camera every frame. A dome larger than the far plane is clipped away
   * entirely, which renders the sky black.
   */
  private createSky(): void {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x2b6ea8) },
        horizon: { value: new THREE.Color(0xbcd6e4) },
        // Matches the fog exactly, so terrain fading into the distance meets
        // the dome without a visible seam at the horizon.
        ground: { value: new THREE.Color(0x9fbdd0) },
      },
      vertexShader: `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 zenith;
        uniform vec3 horizon;
        uniform vec3 ground;
        varying vec3 vDirection;
        void main() {
          float height = normalize(vDirection).y;
          vec3 sky = mix(horizon, zenith, pow(clamp(height, 0.0, 1.0), 0.55));
          vec3 colour = mix(ground, sky, smoothstep(-0.12, 0.05, height));
          gl_FragColor = vec4(colour, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(40_000, 48, 32), material);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  private createTerrain(): void {
    // The mesh samples the same height field the simulation collides against,
    // so what the viewer draws as ground is exactly what the physics treats as
    // ground.
    const segments = 220;
    const geometry = new THREE.PlaneGeometry(TERRAIN_EXTENT_M, TERRAIN_EXTENT_M, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes["position"]!;
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, terrainHeight(positions.getX(i), positions.getZ(i)));
    }
    geometry.computeVertexNormals();

    // Tint by height and steepness so the relief reads from altitude: valley
    // scrub, dry slopes, and bare rock on the faces too steep to hold soil.
    const normals = geometry.attributes["normal"]!;
    const colours = new Float32Array(positions.count * 3);
    const valley = new THREE.Color(0x5c6b45);
    const slope = new THREE.Color(0x8a7f57);
    const rock = new THREE.Color(0x6d675f);
    const shade = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const height = Math.min(1, positions.getY(i) / 700);
      const steepness = 1 - Math.min(1, Math.max(0, normals.getY(i)));
      shade.copy(valley).lerp(slope, height).lerp(rock, Math.min(1, steepness * 3.2));
      colours[i * 3] = shade.r;
      colours[i * 3 + 1] = shade.g;
      colours[i * 3 + 2] = shade.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));

    this.scene.add(
      new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 }),
      ),
    );
  }

  private ensureAircraft(snapshot: ViewerSnapshot): void {
    if (!this.modelTemplate) return;
    for (const aircraft of snapshot.aircraft) {
      if (this.aircraftMeshes.has(aircraft.id)) continue;
      const mesh = this.modelTemplate.clone(true);
      mesh.name = aircraft.id;
      // Team livery. Two identical grey jets are impossible to tell apart at a
      // kilometre, so each side gets a tint and a faint emissive glow that
      // survives being backlit against the sky.
      const tint = aircraft.team === "red" ? new THREE.Color(1.3, 0.62, 0.58) : new THREE.Color(0.66, 0.84, 1.28);
      const glow = aircraft.team === "red" ? 0x2a0806 : 0x04162c;
      mesh.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.frustumCulled = true;
        const source = Array.isArray(object.material) ? object.material[0] : object.material;
        if (!source || !("color" in source)) return;
        const material = (source as THREE.MeshStandardMaterial).clone();
        material.color.multiply(tint);
        material.emissive = new THREE.Color(glow);
        object.material = material;
      });
      this.aircraftMeshes.set(aircraft.id, mesh);
      this.scene.add(mesh);
    }
  }

  render(snapshot: ViewerSnapshot): void {
    if (this.contextLost) return;
    this.ensureAircraft(snapshot);
    for (const aircraft of snapshot.aircraft) {
      const mesh = this.aircraftMeshes.get(aircraft.id);
      if (!mesh) continue;
      mesh.position.fromArray(aircraft.position);
      mesh.quaternion.fromArray(aircraft.orientation);
      mesh.visible = aircraft.alive;
      this.updatePlume(aircraft);
    }
    this.spawnEffects(snapshot);
    this.ageEffects(snapshot.time);

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
    this.sky?.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Afterburner plume.
   *
   * Deliberately *not* parented to the aircraft mesh: the framing measurement
   * walks the followed mesh's vertices, and a plume inside it would inflate the
   * bounds and quietly change what "centred" means.
   */
  private updatePlume(aircraft: ViewerAircraft): void {
    let plume = this.plumes.get(aircraft.id);
    if (!plume) {
      const geometry = new THREE.ConeGeometry(0.62, 7, 12, 1, true);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0, -3.5);
      plume = new THREE.Mesh(geometry, this.plumeMaterial.clone());
      this.effectGroup.add(plume);
      this.plumes.set(aircraft.id, plume);
    }

    const lit = aircraft.alive && aircraft.afterburner === true;
    plume.visible = lit;
    if (!lit) return;
    plume.quaternion.fromArray(aircraft.orientation);
    plume.position
      .fromArray(aircraft.position)
      .addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(plume.quaternion), -6.4);
    // A little flicker stops it reading as a solid plastic cone.
    const material = plume.material as THREE.MeshBasicMaterial;
    material.opacity = 0.42 + Math.random() * 0.22;
    plume.scale.setZ(0.85 + Math.random() * 0.3);
  }

  private spawnEffects(snapshot: ViewerSnapshot): void {
    for (const impact of snapshot.impacts ?? []) {
      const spark = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6), this.sparkMaterial.clone());
      spark.position.fromArray(impact);
      this.effectGroup.add(spark);
      this.effects.push({ mesh: spark, born: snapshot.time, life: 0.55, grow: 26 });
    }

    // A damaged jet trails smoke, so a fight's state is legible from outside.
    const elapsed = snapshot.time - this.lastEffectTime;
    if (elapsed < 0.05) return;
    this.lastEffectTime = snapshot.time;
    for (const aircraft of snapshot.aircraft) {
      if (!aircraft.alive || (aircraft.integrity ?? 1) > 0.7) continue;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), this.smokeMaterial.clone());
      puff.position
        .fromArray(aircraft.position)
        .addScaledVector(
          new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(aircraft.orientation)),
          -5,
        );
      this.effectGroup.add(puff);
      this.effects.push({ mesh: puff, born: snapshot.time, life: 2.6, grow: 9 });
    }
  }

  private ageEffects(time: number): void {
    for (let index = this.effects.length - 1; index >= 0; index--) {
      const effect = this.effects[index]!;
      // Replays can be scrubbed backwards, which would otherwise strand effects.
      const age = time - effect.born;
      if (age < 0 || age > effect.life) {
        this.effectGroup.remove(effect.mesh);
        effect.mesh.geometry.dispose();
        (effect.mesh.material as THREE.Material).dispose();
        this.effects.splice(index, 1);
        continue;
      }
      const progress = age / effect.life;
      effect.mesh.scale.setScalar(1 + progress * effect.grow);
      (effect.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.6;
    }
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
    for (const effect of this.effects) {
      effect.mesh.geometry.dispose();
      (effect.mesh.material as THREE.Material).dispose();
    }
    this.effects.length = 0;
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.resizeObserver?.disconnect();
    this.pixelRatioQuery?.removeEventListener("change", this.onPixelRatioChange);
    removeEventListener("resize", this.onResize);
  }

  /**
   * Re-arms a listener for device pixel ratio changes.
   *
   * Dragging the window from a Retina display to an external monitor changes
   * the ratio without changing the element's size, so a resize observer never
   * fires and the canvas keeps rendering at the wrong density.
   */
  private watchPixelRatio(): void {
    if (typeof matchMedia === "undefined") return;
    this.pixelRatioQuery?.removeEventListener("change", this.onPixelRatioChange);
    this.pixelRatioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.pixelRatioQuery.addEventListener("change", this.onPixelRatioChange);
  }

  /** True while the GPU context is gone, so callers can show a notice. */
  contextLost = false;

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.resize();
  };

  private readonly onPixelRatioChange = () => {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.resize();
    this.watchPixelRatio();

    // A browser may take the WebGL context away at any time -- Safari does it
    // under memory pressure or when a tab is backgrounded. Calling
    // preventDefault is what allows the browser to hand it back; without it the
    // canvas stays blank for good. three re-uploads its own resources on
    // restore, so nothing else has to be rebuilt.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  };

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    // A zero measurement means the element is not laid out yet. Sizing to it
    // would bake in a broken canvas that nothing later corrects.
    if (width <= 0 || height <= 0) return;
    // updateStyle must stay on. With it off, three sets the backing store to
    // width * devicePixelRatio but leaves the element with no CSS size, so on a
    // Retina display the canvas lays out at twice the viewport, anchored top
    // left, and everything the camera considers centred is drawn off the
    // bottom-right of the screen.
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
}
