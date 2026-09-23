import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MISSILE, NOZZLE } from "../sim/config";
import { AIM9_LENGTH_M, aim9Materials, createAim9 } from "./aim9";
import {
  SEA_LEVEL_M,
  TERRAIN_CHUNKS,
  TERRAIN_CHUNK_SEGMENTS,
  TERRAIN_EXTENT_M,
  elevationNormal,
  terrainElevation,
  terrainHeight,
} from "../sim/terrain";
import { fractal } from "../sim/noise";
import { TRACER_TRAIL_SECONDS } from "../sim/tracer";
import { CameraDirector } from "./cameras";
import type { ViewMode } from "./cameras";
import type { ViewerAircraft, ViewerBurst, ViewerSnapshot } from "./types";
import type { MatchState } from "../sim/types";

export type { ViewMode } from "./cameras";
export type { ViewerAircraft, ViewerBurst, ViewerMissile, ViewerSnapshot, ViewerTracer } from "./types";

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
      rails: railsLoaded(aircraft.stores.missileStations, aircraft.stores.missiles),
    })),
    tracers: state.projectiles.slice(-MAX_TRACERS).map((shot) => {
      const speed = shot.velocity.length();
      const trail = Math.min(TRACER_TRAIL_SECONDS * speed, speed * shot.age);
      const direction = shot.velocity.clone().divideScalar(Math.max(speed, 1e-6));
      return {
        from: shot.position.clone().addScaledVector(direction, -trail).toArray() as [number, number, number],
        to: shot.position.toArray() as [number, number, number],
      };
    }),
    impacts,
    missiles: state.missiles.map((missile) => ({
      id: missile.id,
      position: missile.position.toArray() as [number, number, number],
      velocity: missile.velocity.toArray() as [number, number, number],
      motor: missile.motorRemainingS > 0,
    })),
    flares: state.flares.map((flare) => flare.position.toArray() as [number, number, number]),
    bursts: burstsFrom(state.events.slice(sinceEventIndex)),
  };
}

/** Rails are emptied in order, so the first ones fired are the first ones bare. */
export function railsLoaded(stations: number, remaining: number): boolean[] {
  return RAIL_MOUNTS.map((_mount, rail) => rail < stations && rail >= stations - remaining);
}

export function burstsFrom(events: MatchState["events"]): ViewerBurst[] {
  const bursts: ViewerBurst[] = [];
  for (const event of events) {
    if (!event.position) continue;
    if (event.type === "missile-detonation") bursts.push({ position: event.position, time: event.time, kind: "warhead" });
    if (event.type === "missile-expired" && event.detail !== "hit the ground") {
      bursts.push({ position: event.position, time: event.time, kind: "self-destruct" });
    }
  }
  return bursts;
}

/** A tiling sheet of soft blobs, thin enough to fly through. */
function cloudTexture(size = 512): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const density = Math.max(0, fractal((x / size) * 4, (y / size) * 4, 5, 4) - 0.42) / 0.58;
      const index = (y * size + x) * 4;
      image.data[index] = 255;
      image.data[index + 1] = 255;
      image.data[index + 2] = 255;
      image.data[index + 3] = Math.min(255, Math.round(density * 300));
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function makePuffTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0.55)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

const MAX_TRACERS = 420;

const RENDER_SCALE_RAISE_MS = 17.5;
const RENDER_SCALE_DROP_MS = 26;

function pinnedRenderScale(): number | undefined {
  if (typeof location === "undefined") return undefined;
  const raw = new URLSearchParams(location.search).get("render-scale");
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

const PLUME_LENGTH_M = 7;

/** Where each rail's missile sits on the model: sim right is model -x. */
const RAIL_MOUNTS = MISSILE.rails.map(([right, up, nose]) => new THREE.Vector3(-right, up, nose));
/** Smoke is laid by distance, not by frame, so a slow frame rate leaves no gaps. */
const SMOKE_SPACING_M = 9;
const MAX_PUFFS_PER_FRAME = 240;
const FLARE_SMOKE_EVERY_S = 0.07;
/** Past this many live sprites a new puff is skipped rather than added. */
const MAX_EFFECTS = 2_400;

const PLUME_ANCHOR = new THREE.Vector3(0, NOZZLE.centreYM, NOZZLE.exitZM);

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 400_000);
  readonly controls: OrbitControls;
  private readonly director: CameraDirector;
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  private readonly tracerGeometry = new THREE.BufferGeometry();
  private readonly tracerPositions = new Float32Array(MAX_TRACERS * 6);
  private readonly tracerLines: THREE.LineSegments;
  private readonly effectGroup = new THREE.Group();
  private sky?: THREE.Mesh;
  private readonly plumes = new Map<string, THREE.Mesh>();
  private readonly effects: Array<{
    mesh: THREE.Sprite;
    born: number;
    life: number;
    grow: number;
    size: number;
    peak: number;
  }> = [];
  private lastEffectTime = 0;
  private readonly smokeFrom = new Map<number, { position: THREE.Vector3; time: number }>();
  private lastFlareSmokeTime = 0;
  private readonly missileMeshes: THREE.Group[] = [];
  private readonly flareSprites: THREE.Sprite[] = [];
  private readonly drawnBursts = new Set<string>();
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
  private readonly puffTexture = makePuffTexture();
  private readonly aim9Materials = aim9Materials();
  private readonly aim9Template = createAim9(this.aim9Materials);
  private readonly missileFlameMaterial = new THREE.SpriteMaterial({
    map: this.puffTexture,
    color: 0xffc27a,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly flareMaterial = new THREE.SpriteMaterial({
    map: this.puffTexture,
    color: 0xfff1c9,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly missileSmokeMaterial = new THREE.SpriteMaterial({
    map: this.puffTexture,
    color: 0xe4e2de,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  private readonly sparkMaterial = new THREE.SpriteMaterial({
    map: this.puffTexture,
    color: 0xffb257,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly smokeMaterial = new THREE.SpriteMaterial({
    map: this.puffTexture,
    color: 0x6d6560,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  });

  private readonly onResize = () => this.resize();
  private resizeObserver?: ResizeObserver;
  private frameTime = 16;
  private lastFrameAt = 0;
  private renderScale = 1;
  private readonly maxScale = typeof devicePixelRatio === "number" && devicePixelRatio >= 1.5 ? 1 : 1.5;
  private readonly pinnedScale = pinnedRenderScale();
  private lastScaleChangeAt = 0;
  private pixelRatioQuery?: MediaQueryList;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      logarithmicDepthBuffer: true,
    });
    this.applyPixelRatio();
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
    this.controls.enableZoom = false;
    this.director = new CameraDirector(this.camera, this.controls);

    this.scene.fog = new THREE.FogExp2(0x9fbdd0, 0.0000195);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x6b5a3a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d0, 3.0);
    sun.position.set(-9_000, 11_000, 6_000);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x9ab2c4, 0.8));
    this.tracerGeometry.setAttribute("position", new THREE.BufferAttribute(this.tracerPositions, 3));
    this.tracerLines = new THREE.LineSegments(this.tracerGeometry, this.tracerMaterial);
    this.tracerLines.frustumCulled = false;
    this.scene.add(this.tracerLines);
    this.scene.add(this.effectGroup);
    this.createSky();
    this.createTerrain();
    this.createClouds();
    this.resize();
    addEventListener("resize", this.onResize);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    this.watchPixelRatio();

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
    this.director.reset();
  }

  setView(view: ViewMode): void {
    this.director.setView(view);
  }

  setPointerCaptured(captured: boolean): void {
    this.director.setPointerCaptured(captured);
  }

  orbitBy(deltaXPixels: number, deltaYPixels: number): void {
    this.director.orbitBy(deltaXPixels, deltaYPixels);
  }

  zoomBy(factor: number): void {
    this.director.zoomBy(factor);
  }

  get viewMode(): ViewMode {
    return this.director.mode;
  }

  private createSky(): void {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color(0x2b6ea8) },
        horizon: { value: new THREE.Color(0xbcd6e4) },
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
    this.scene.add(
      this.buildTerrainMesh(
        new THREE.RingGeometry(TERRAIN_EXTENT_M * 0.48, 260_000, 96, 28).rotateX(-Math.PI / 2),
      ),
    );

    const chunksPerSide = TERRAIN_CHUNKS;
    const segmentsPerChunk = TERRAIN_CHUNK_SEGMENTS;
    const chunkExtent = TERRAIN_EXTENT_M / chunksPerSide;
    for (let row = 0; row < chunksPerSide; row += 1) {
      for (let column = 0; column < chunksPerSide; column += 1) {
        const centreX = (column + 0.5) * chunkExtent - TERRAIN_EXTENT_M / 2;
        const centreZ = (row + 0.5) * chunkExtent - TERRAIN_EXTENT_M / 2;
        const geometry = new THREE.PlaneGeometry(chunkExtent, chunkExtent, segmentsPerChunk, segmentsPerChunk)
          .rotateX(-Math.PI / 2)
          .translate(centreX, 0, centreZ);
        this.scene.add(this.buildTerrainMesh(geometry));
      }
    }

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(520_000, 520_000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x1d4763,
        roughness: 0.18,
        metalness: 0.55,
        transparent: true,
        opacity: 0.88,
      }),
    );
    water.position.y = SEA_LEVEL_M;
    water.renderOrder = 1;
    this.scene.add(water);
  }

  private buildTerrainMesh(geometry: THREE.BufferGeometry): THREE.Mesh {
    const positions = geometry.attributes["position"]!;
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, terrainElevation(positions.getX(i), positions.getZ(i)));
    }

    const normalValues = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
      const [nx, ny, nz] = elevationNormal(positions.getX(i), positions.getZ(i));
      normalValues[i * 3] = nx;
      normalValues[i * 3 + 1] = ny;
      normalValues[i * 3 + 2] = nz;
    }
    geometry.setAttribute("normal", new THREE.BufferAttribute(normalValues, 3));

    const normals = geometry.attributes["normal"]!;
    const colours = new Float32Array(positions.count * 3);
    const seabed = new THREE.Color(0x24384a);
    const shore = new THREE.Color(0xa99a72);
    const lowland = new THREE.Color(0x55703f);
    const upland = new THREE.Color(0x6d6f4a);
    const rock = new THREE.Color(0x6b6560);
    const snow = new THREE.Color(0xd8dde0);
    const shade = new THREE.Color();

    for (let i = 0; i < positions.count; i++) {
      const elevation = positions.getY(i);
      const steepness = 1 - Math.min(1, Math.max(0, normals.getY(i)));
      if (elevation < SEA_LEVEL_M) {
        shade.copy(seabed).lerp(shore, Math.max(0, 1 + elevation / 220));
      } else {
        shade.copy(shore);
        shade.lerp(lowland, Math.min(1, elevation / 130));
        shade.lerp(upland, Math.min(1, Math.max(0, (elevation - 420) / 700)));
        shade.lerp(rock, Math.min(1, steepness * 2.6));
        shade.lerp(snow, Math.min(1, Math.max(0, (elevation - 1_500) / 500)));
      }
      colours[i * 3] = shade.r;
      colours[i * 3 + 1] = shade.g;
      colours[i * 3 + 2] = shade.b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));

    return new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }),
    );
  }

  private createClouds(): void {
    const texture = cloudTexture();
    const decks: Array<{ altitude: number; repeat: number; opacity: number; colour: number }> = [
      { altitude: 1_500, repeat: 26, opacity: 0.5, colour: 0xf2f6f8 },
      { altitude: 3_400, repeat: 16, opacity: 0.42, colour: 0xe9f0f5 },
      { altitude: 6_200, repeat: 9, opacity: 0.3, colour: 0xdfe9f2 },
    ];

    for (const deck of decks) {
      const layer = texture.clone();
      layer.needsUpdate = true;
      layer.wrapS = THREE.RepeatWrapping;
      layer.wrapT = THREE.RepeatWrapping;
      layer.repeat.set(deck.repeat, deck.repeat);
      layer.offset.set(deck.altitude / 1_000, deck.altitude / 700);

      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(150_000, 150_000).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          map: layer,
          color: deck.colour,
          transparent: true,
          opacity: deck.opacity,
          depthWrite: false,
          side: THREE.DoubleSide,
          fog: true,
        }),
      );
      mesh.position.y = deck.altitude;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
    }
  }

  private ensureAircraft(snapshot: ViewerSnapshot): void {
    if (!this.modelTemplate) return;
    for (const aircraft of snapshot.aircraft) {
      if (this.aircraftMeshes.has(aircraft.id)) continue;
      const mesh = this.modelTemplate.clone(true);
      mesh.name = aircraft.id;
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
      RAIL_MOUNTS.forEach((mount, rail) => {
        const carried = this.aim9Template.clone(true);
        carried.name = `rail-${rail}`;
        carried.position.copy(mount);
        carried.visible = false;
        mesh.add(carried);
      });
      this.aircraftMeshes.set(aircraft.id, mesh);
      this.scene.add(mesh);
    }
  }

  render(snapshot: ViewerSnapshot): void {
    if (this.contextLost) return;
    this.adaptResolution();
    this.ensureAircraft(snapshot);
    for (const aircraft of snapshot.aircraft) {
      const mesh = this.aircraftMeshes.get(aircraft.id);
      if (!mesh) continue;
      mesh.position.fromArray(aircraft.position);
      mesh.quaternion.fromArray(aircraft.orientation);
      mesh.visible = aircraft.alive;
      RAIL_MOUNTS.forEach((_mount, rail) => {
        const carried = mesh.getObjectByName(`rail-${rail}`);
        if (carried) carried.visible = aircraft.rails?.[rail] === true;
      });
      this.updatePlume(aircraft);
    }
    this.spawnEffects(snapshot);
    this.drawMissiles(snapshot);
    this.drawFlares(snapshot);
    this.drawBursts(snapshot);
    this.ageEffects(snapshot.time);

    let vertex = 0;
    for (const tracer of snapshot.tracers) {
      if (vertex >= MAX_TRACERS * 6) break;
      const [ax, ay, az] = tracer.from;
      const [bx, by, bz] = tracer.to;
      if ((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 < 0.25) continue;
      this.tracerPositions[vertex++] = ax;
      this.tracerPositions[vertex++] = ay;
      this.tracerPositions[vertex++] = az;
      this.tracerPositions[vertex++] = bx;
      this.tracerPositions[vertex++] = by;
      this.tracerPositions[vertex++] = bz;
    }
    this.tracerGeometry.setDrawRange(0, vertex / 3);
    this.tracerGeometry.attributes["position"]!.needsUpdate = true;

    this.positionCamera(snapshot);
    this.sky?.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  private positionCamera(snapshot: ViewerSnapshot): void {
    const follow = snapshot.aircraft.find((aircraft) => aircraft.id === this.followId) ?? snapshot.aircraft[0];
    if (!follow) return;
    const mesh = this.aircraftMeshes.get(follow.id);
    // Centre of the airframe rather than its origin: the model's origin sits at
    // the nose, and a camera aimed there frames the jet off to one side.
    const centre = mesh
      ? new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
      : new THREE.Vector3().fromArray(follow.position);
    const other = snapshot.aircraft.find((aircraft) => aircraft.id !== follow.id);
    const bandit = other ? new THREE.Vector3().fromArray(other.position) : undefined;

    if (this.director.update(follow, centre, bandit) && mesh) mesh.visible = false;
  }

  private updatePlume(aircraft: ViewerAircraft): void {
    let plume = this.plumes.get(aircraft.id);
    if (!plume) {
      const geometry = new THREE.ConeGeometry(NOZZLE.exitRadiusM, PLUME_LENGTH_M, 12, 1, true);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0, -PLUME_LENGTH_M / 2);
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
      .add(PLUME_ANCHOR.clone().applyQuaternion(plume.quaternion));
    const material = plume.material as THREE.MeshBasicMaterial;
    material.opacity = 0.42 + Math.random() * 0.22;
    plume.scale.setZ(0.85 + Math.random() * 0.3);
  }

  private spawnEffects(snapshot: ViewerSnapshot): void {
    for (const impact of snapshot.impacts ?? []) {
      const spark = new THREE.Sprite(this.sparkMaterial.clone());
      spark.position.fromArray(impact);
      this.effectGroup.add(spark);
      this.effects.push({ mesh: spark, born: snapshot.time, life: 0.55, grow: 9, size: 3, peak: 0.9 });
    }

    const elapsed = snapshot.time - this.lastEffectTime;
    if (elapsed < 0.05) return;
    this.lastEffectTime = snapshot.time;
    for (const aircraft of snapshot.aircraft) {
      if (!aircraft.alive || (aircraft.integrity ?? 1) > 0.7) continue;
      const puff = new THREE.Sprite(this.smokeMaterial.clone());
      puff.position
        .fromArray(aircraft.position)
        .addScaledVector(
          new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(aircraft.orientation)),
          -5,
        );
      this.effectGroup.add(puff);
      this.effects.push({ mesh: puff, born: snapshot.time, life: 2.6, grow: 5, size: 6, peak: 0.34 });
    }
  }

  private addEffect(
    material: THREE.SpriteMaterial,
    position: THREE.Vector3 | [number, number, number],
    time: number,
    shape: { life: number; grow: number; size: number; peak: number },
  ): void {
    if (this.effects.length >= MAX_EFFECTS) return;
    const sprite = new THREE.Sprite(material.clone());
    if (Array.isArray(position)) sprite.position.fromArray(position);
    else sprite.position.copy(position);
    sprite.scale.setScalar(shape.size);
    this.effectGroup.add(sprite);
    this.effects.push({ mesh: sprite, born: time, ...shape });
  }

  private missileMesh(index: number): THREE.Group {
    let mesh = this.missileMeshes[index];
    if (mesh) return mesh;
    mesh = new THREE.Group();
    mesh.add(this.aim9Template.clone(true));
    const flame = new THREE.Sprite(this.missileFlameMaterial);
    flame.name = "flame";
    flame.position.z = -AIM9_LENGTH_M / 2 - 0.5;
    flame.scale.setScalar(1.6);
    mesh.add(flame);
    this.scene.add(mesh);
    this.missileMeshes[index] = mesh;
    return mesh;
  }

  private drawMissiles(snapshot: ViewerSnapshot): void {
    const missiles = snapshot.missiles ?? [];
    const forward = new THREE.Vector3(0, 0, 1);
    const seen = new Set<number>();
    let budget = MAX_PUFFS_PER_FRAME;
    missiles.forEach((missile, index) => {
      const mesh = this.missileMesh(index);
      mesh.visible = true;
      mesh.position.fromArray(missile.position);
      const velocity = new THREE.Vector3().fromArray(missile.velocity);
      const speed = velocity.length();
      if (speed > 1) mesh.quaternion.setFromUnitVectors(forward, velocity.clone().divideScalar(speed));
      const flame = mesh.getObjectByName("flame");
      if (flame) {
        flame.visible = missile.motor;
        flame.scale.setScalar(1.3 + Math.random() * 0.7);
      }

      seen.add(missile.id);
      const here = new THREE.Vector3().fromArray(missile.position);
      const from = this.smokeFrom.get(missile.id);
      // A jump further than it could have flown is a seek or a new match, not a trail.
      const plausible =
        from && snapshot.time > from.time && here.distanceTo(from.position) < speed * (snapshot.time - from.time) * 1.5 + 50;
      if (missile.motor && from && plausible) {
        const path = here.clone().sub(from.position);
        const length = path.length();
        const puffs = Math.min(Math.floor(length / SMOKE_SPACING_M), budget);
        for (let puff = 1; puff <= puffs; puff += 1) {
          const along = (puff * SMOKE_SPACING_M) / length;
          this.addEffect(
            this.missileSmokeMaterial,
            from.position.clone().addScaledVector(path, along),
            from.time + (snapshot.time - from.time) * along,
            { life: 6, grow: 4, size: 3.5, peak: 0.6 },
          );
        }
        budget -= puffs;
        if (puffs > 0) {
          const laid = (puffs * SMOKE_SPACING_M) / length;
          from.position.addScaledVector(path, laid);
          from.time += (snapshot.time - from.time) * laid;
        }
      } else {
        this.smokeFrom.set(missile.id, { position: here, time: snapshot.time });
      }
    });
    for (const id of this.smokeFrom.keys()) if (!seen.has(id)) this.smokeFrom.delete(id);
    for (let index = missiles.length; index < this.missileMeshes.length; index += 1) {
      this.missileMeshes[index]!.visible = false;
    }
  }

  private drawFlares(snapshot: ViewerSnapshot): void {
    const flares = snapshot.flares ?? [];
    const smoke = snapshot.time - this.lastFlareSmokeTime >= FLARE_SMOKE_EVERY_S || snapshot.time < this.lastFlareSmokeTime;
    if (smoke) this.lastFlareSmokeTime = snapshot.time;
    flares.forEach((position, index) => {
      let sprite = this.flareSprites[index];
      if (!sprite) {
        sprite = new THREE.Sprite(this.flareMaterial);
        this.effectGroup.add(sprite);
        this.flareSprites[index] = sprite;
      }
      sprite.visible = true;
      sprite.position.fromArray(position);
      sprite.scale.setScalar(5 + Math.random() * 3);
      if (smoke) {
        this.addEffect(this.smokeMaterial, position, snapshot.time, { life: 2.4, grow: 3, size: 2, peak: 0.28 });
      }
    });
    for (let index = flares.length; index < this.flareSprites.length; index += 1) {
      this.flareSprites[index]!.visible = false;
    }
  }

  private drawBursts(snapshot: ViewerSnapshot): void {
    for (const burst of snapshot.bursts ?? []) {
      const key = `${burst.time.toFixed(3)}:${burst.position.map((value) => value.toFixed(0)).join(",")}`;
      if (this.drawnBursts.has(key)) continue;
      this.drawnBursts.add(key);
      if (this.drawnBursts.size > 64) this.drawnBursts.delete(this.drawnBursts.values().next().value!);
      const warhead = burst.kind === "warhead";
      this.addEffect(this.sparkMaterial, burst.position, snapshot.time, {
        life: warhead ? 0.8 : 0.5,
        grow: warhead ? 6 : 3,
        size: warhead ? 7 : 3,
        peak: 1,
      });
      this.addEffect(this.smokeMaterial, burst.position, snapshot.time, {
        life: warhead ? 5 : 3,
        grow: warhead ? 4 : 2.5,
        size: warhead ? 9 : 4,
        peak: 0.55,
      });
    }
  }

  private ageEffects(time: number): void {
    for (let index = this.effects.length - 1; index >= 0; index--) {
      const effect = this.effects[index]!;
      const age = time - effect.born;
      if (age < 0 || age > effect.life) {
        this.effectGroup.remove(effect.mesh);
        (effect.mesh.material as THREE.Material).dispose();
        this.effects.splice(index, 1);
        continue;
      }
      const progress = age / effect.life;
      effect.mesh.scale.setScalar(effect.size * (1 + progress * effect.grow));
      (effect.mesh.material as THREE.SpriteMaterial).opacity = (1 - progress) * effect.peak;
    }
  }

  private adaptResolution(): void {
    const now = performance.now();
    if (this.pinnedScale !== undefined) {
      if (this.lastFrameAt > 0) {
        const delta = now - this.lastFrameAt;
        if (delta < 500) this.frameTime += (delta - this.frameTime) * 0.1;
      }
      this.lastFrameAt = now;
      return;
    }
    if (this.lastFrameAt > 0) {
      const delta = now - this.lastFrameAt;
      if (delta < 500) this.frameTime += (delta - this.frameTime) * 0.1;
    }
    this.lastFrameAt = now;

    if (now - this.lastScaleChangeAt < 1_500) return;
    const previous = this.renderScale;

    if (this.frameTime > RENDER_SCALE_DROP_MS && this.renderScale > 0.5) {
      this.renderScale = Math.max(0.5, this.renderScale - 0.25);
    } else if (this.frameTime < RENDER_SCALE_RAISE_MS && this.renderScale < this.maxScale) {
      this.renderScale = Math.min(this.maxScale, this.renderScale + 0.25);
    }

    if (this.renderScale !== previous) {
      this.lastScaleChangeAt = now;
      this.frameTime = 16;
      this.applyPixelRatio();
      this.resize();
    }
  }

  get stats(): { frameTimeMs: number; renderScale: number; drawCalls: number; triangles: number; programs: number } {
    return {
      frameTimeMs: this.frameTime,
      renderScale: this.renderScale,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  private applyPixelRatio(): void {
    const scale = this.pinnedScale ?? this.renderScale;
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(Math.min(devicePixelRatio, 2) * scale, 2)));
  }

  project(point: THREE.Vector3): { x: number; y: number; behind: boolean } {
    const projected = point.clone().project(this.camera);
    const toCamera = point.clone().sub(this.camera.position);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    return {
      x: (projected.x + 1) / 2,
      y: (1 - projected.y) / 2,
      behind: toCamera.dot(forward) <= 0,
    };
  }

  getFollowFraming():
    | { x: number; y: number; minX: number; maxX: number; minY: number; maxY: number; distanceM: number }
    | undefined {
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
      distanceM: this.camera.position.distanceTo(mesh.position),
      x: (centerX + 1) / 2,
      y: (1 - centerY) / 2,
      minX: (minX + 1) / 2,
      maxX: (maxX + 1) / 2,
      minY: (1 - maxY) / 2,
      maxY: (1 - minY) / 2,
    };
  }

  dispose(): void {
    for (const effect of this.effects) {
      effect.mesh.geometry.dispose();
      (effect.mesh.material as THREE.Material).dispose();
    }
    this.effects.length = 0;
    this.aim9Template.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    for (const material of Object.values(this.aim9Materials)) material.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.resizeObserver?.disconnect();
    this.pixelRatioQuery?.removeEventListener("change", this.onPixelRatioChange);
    removeEventListener("resize", this.onResize);
  }

  private watchPixelRatio(): void {
    if (typeof matchMedia === "undefined") return;
    this.pixelRatioQuery?.removeEventListener("change", this.onPixelRatioChange);
    this.pixelRatioQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    this.pixelRatioQuery.addEventListener("change", this.onPixelRatioChange);
  }

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

    const canvas = this.renderer.domElement;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  };

  private resize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }
}
