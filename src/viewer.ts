import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NOZZLE } from "./sim/config";
import { SEA_LEVEL_M, TERRAIN_EXTENT_M, terrainElevation, terrainHeight } from "./sim/terrain";
import { TRACER_TRAIL_SECONDS } from "./sim/tracer";
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

/**
 * A tracer as a finished line segment: where the round was, and where it is.
 *
 * Both ends are resolved by whoever produces the snapshot, so the renderer has
 * no direction to infer and no fallback to get wrong. The previous shape gave
 * the renderer a position and an optional direction, and replays -- which had
 * no direction to give -- fell back to a short vertical stroke, so every
 * replayed burst was drawn as a row of vertical lines.
 */
export interface ViewerTracer {
  /** Tail: where the round was a few milliseconds ago. */
  a: [number, number, number];
  /** Head: where the round is now. */
  b: [number, number, number];
}

/**
 * Where the camera sits.
 *
 * `orbit` is the external chase view. `cockpit` puts the eye at the pilot's
 * position looking along the nose, which is the only view in which conformal
 * head-up symbology -- a pitch ladder, a flight path marker, a gun cross -- is
 * actually telling the truth.
 */
export type ViewMode = "orbit" | "cockpit";

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
    tracers: state.projectiles.slice(-MAX_TRACERS).map((shot) => {
      const speed = shot.velocity.length();
      // The streak is where the round has been over the last few milliseconds,
      // which for a round that has only just left the muzzle is barely
      // anywhere -- drawing a full-length tail puts it out behind the tailplane.
      const trail = Math.min(TRACER_TRAIL_SECONDS * speed, speed * shot.age);
      const direction = shot.velocity.clone().divideScalar(Math.max(speed, 1e-6));
      return {
        a: shot.position.clone().addScaledVector(direction, -trail).toArray() as [number, number, number],
        b: shot.position.toArray() as [number, number, number],
      };
    }),
    impacts,
  };
}

/**
 * Procedural cloud sheet.
 *
 * Generated rather than shipped: it keeps the bundle free of a texture asset
 * and lets the coverage be tuned in one place. Alpha is fractal noise with a
 * floor subtracted, which leaves broken cloud rather than uniform haze.
 */
function cloudTexture(size = 512): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(size, size);

  const hash = (ix: number, iy: number) => {
    let h = Math.imul(ix | 0, 374_761_393) + Math.imul(iy | 0, 668_265_263);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  // Wrapping value noise, so the sheet tiles without a visible seam.
  const value = (x: number, y: number, period: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const wrap = (v: number) => ((v % period) + period) % period;
    const a = hash(wrap(ix), wrap(iy));
    const b = hash(wrap(ix + 1), wrap(iy));
    const c = hash(wrap(ix), wrap(iy + 1));
    const d = hash(wrap(ix + 1), wrap(iy + 1));
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0;
      let amplitude = 1;
      let total = 0;
      let period = 4;
      for (let octave = 0; octave < 5; octave += 1) {
        sum += value((x / size) * period, (y / size) * period, period) * amplitude;
        total += amplitude;
        amplitude *= 0.5;
        period *= 2;
      }
      const density = Math.max(0, sum / total - 0.42) / 0.58;
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

/** Most tracers drawn at once; a full burst is about a hundred rounds in flight. */
const MAX_TRACERS = 420;

/** Pilot's eye in body axes: up out of the seat, forward under the canopy. */
const COCKPIT_EYE = new THREE.Vector3(0, 1.05, 3.3);
/** three cameras look down -z, the aircraft's nose is +z, so turn them around. */
const NOSE_FORWARD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/** Length of the afterburner flame at rest, metres. */
const PLUME_LENGTH_M = 7;

/** Where the flame starts, in body axes: the nozzle exit, not the tail bumper. */
const PLUME_ANCHOR = new THREE.Vector3(0, NOZZLE.centreYM, NOZZLE.exitZM);

export class DogfightViewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.3, 400_000);
  readonly controls: OrbitControls;
  private readonly aircraftMeshes = new Map<string, THREE.Object3D>();
  /**
   * All tracers in one buffer.
   *
   * The previous version allocated a geometry, a material binding and a Line
   * object for every round on screen, every frame -- several hundred objects a
   * frame during a burst, all of them garbage. One pre-allocated buffer with a
   * draw range costs nothing per frame.
   */
  private readonly tracerGeometry = new THREE.BufferGeometry();
  private readonly tracerPositions = new Float32Array(MAX_TRACERS * 6);
  private readonly tracerLines: THREE.LineSegments;
  private readonly effectGroup = new THREE.Group();
  private sky?: THREE.Mesh;
  private readonly plumes = new Map<string, THREE.Mesh>();
  private readonly effects: Array<{ mesh: THREE.Mesh; born: number; life: number; grow: number }> = [];
  private lastEffectTime = 0;
  private modelTemplate?: THREE.Object3D;
  private followId = "blue-1";
  private view: ViewMode = "orbit";
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
  /** Smoothed frame time, milliseconds. */
  private frameTime = 16;
  private lastFrameAt = 0;
  private renderScale = 1;
  private lastScaleChangeAt = 0;
  private pixelRatioQuery?: MediaQueryList;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
      // The scene spans eighty kilometres and the aircraft is fifteen metres
      // long; without a logarithmic depth buffer the model z-fights itself.
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
    this.controls.zoomSpeed = 0.9;

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

  setView(view: ViewMode): void {
    if (view === this.view) return;
    this.view = view;
    this.cameraInitialized = false;
    // Orbiting a camera that is bolted to the aircraft makes no sense, and
    // leaving the controls live would fight the attitude update every frame.
    this.controls.enabled = view === "orbit";
  }

  get viewMode(): ViewMode {
    return this.view;
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
    /**
     * Ground out to the real horizon.
     *
     * The detailed height field is eighty kilometres across, but from twenty
     * thousand feet the horizon is hundreds of kilometres away, so the mesh
     * ended in mid-air and the head-up display's horizon line sat well above
     * where the ground appeared to stop. A plain disc underneath, large enough
     * that the fog swallows it long before its edge, puts the horizon where the
     * pitch ladder says it is.
     */
    // Sampled from the same height field at a coarse resolution, so there is no
    // seam where it meets the detailed mesh -- a flat disc in a single colour
    // left a hard line across the middle distance.
    this.scene.add(
      this.buildTerrainMesh(
        new THREE.RingGeometry(TERRAIN_EXTENT_M * 0.48, 260_000, 96, 28).rotateX(-Math.PI / 2),
      ),
    );

    // The mesh samples the same height field the simulation collides against,
    // so what the viewer draws as ground is exactly what the physics treats as
    // ground.
    const segments = 300;
    this.scene.add(
      this.buildTerrainMesh(
        new THREE.PlaneGeometry(TERRAIN_EXTENT_M, TERRAIN_EXTENT_M, segments, segments).rotateX(-Math.PI / 2),
      ),
    );

    // Sea surface. Slightly translucent so the shallows read as shallow, and
    // rendered after the terrain so the sea floor shows through.
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

  /**
   * Displaces and tints a flat grid into terrain.
   *
   * Shared by the detailed mesh and the coarse ring beyond it, so both read the
   * same height field and the same colour ramp and meet without a seam.
   */
  private buildTerrainMesh(geometry: THREE.BufferGeometry): THREE.Mesh {
    const positions = geometry.attributes["position"]!;
    for (let i = 0; i < positions.count; i++) {
      // Elevation, not collision height, so the sea floor keeps its shape and
      // the coastline is a slope rather than a cliff at the waterline.
      positions.setY(i, terrainElevation(positions.getX(i), positions.getZ(i)));
    }
    geometry.computeVertexNormals();

    /**
     * Tint by elevation and steepness.
     *
     * Height alone gives a layer cake; adding slope puts rock on the faces too
     * steep to hold soil and keeps the flats green, which is what makes relief
     * legible from altitude.
     */
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

  /**
   * Cloud decks.
   *
   * Altitude is almost unreadable over open terrain -- a mountain range looks
   * the same from ten thousand feet as from twenty. Layers of cloud at known
   * heights fix that: passing down through one, or seeing two below you, says
   * more about where you are than any instrument.
   */
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
    this.adaptResolution();
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

    let vertex = 0;
    for (const tracer of snapshot.tracers) {
      if (vertex >= MAX_TRACERS * 6) break;
      const [ax, ay, az] = tracer.a;
      const [bx, by, bz] = tracer.b;
      // A round fired this instant has no streak yet.
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

    const follow =
      snapshot.aircraft.find((aircraft) => aircraft.id === this.followId) ?? snapshot.aircraft[0];
    if (follow) {
      const followMesh = this.aircraftMeshes.get(follow.id);
      if (this.view === "cockpit") {
        this.placeCockpitCamera(follow);
        // You cannot see your own airframe from inside it, and drawing it would
        // fill the screen.
        if (followMesh) followMesh.visible = false;
      } else {
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
    }

    // OrbitControls.update() repositions the camera from its own target and
    // spherical state whether or not it is enabled, so in the cockpit it would
    // silently overwrite the attitude set above -- leaving a view that looks
    // plausible while every conformal projection is computed against the wrong
    // camera.
    if (this.view === "orbit") this.controls.update();
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
      // The cone is built with its base on the nozzle exit plane and its apex
      // trailing aft, so scaling it in z stretches the flame backwards instead
      // of pulling it out of the tailpipe.
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

  /**
   * Trades resolution for frame rate when the machine cannot keep up.
   *
   * At a device pixel ratio of two this scene is drawn at 3200x1800, which a
   * weak GPU cannot sustain. That is not merely ugly: the render loop then
   * monopolises the main thread, React never gets to commit, and the interface
   * stops responding -- navigating to another page changes the URL and nothing
   * happens. Dropping the render scale costs some sharpness and keeps the
   * application usable, which is the better trade every time.
   */
  private adaptResolution(): void {
    const now = performance.now();
    if (this.lastFrameAt > 0) {
      const delta = now - this.lastFrameAt;
      // Ignore long gaps from a backgrounded tab.
      if (delta < 500) this.frameTime += (delta - this.frameTime) * 0.1;
    }
    this.lastFrameAt = now;

    // Hysteresis: never react to a single slow frame, and never oscillate.
    if (now - this.lastScaleChangeAt < 1_500) return;
    const previous = this.renderScale;
    if (this.frameTime > 34 && this.renderScale > 0.5) this.renderScale = Math.max(0.5, this.renderScale - 0.25);
    else if (this.frameTime < 15 && this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.25);

    if (this.renderScale !== previous) {
      this.lastScaleChangeAt = now;
      this.frameTime = 16;
      this.applyPixelRatio();
      this.resize();
    }
  }

  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(devicePixelRatio, 2) * this.renderScale));
  }

  /**
   * Puts the eye where the pilot's head is and points it down the nose.
   *
   * The camera takes the aircraft's roll as well as its heading and pitch: a
   * head-up display is fixed to the airframe, so the horizon rotating behind it
   * is the whole point.
   */
  private placeCockpitCamera(aircraft: ViewerAircraft): void {
    const orientation = new THREE.Quaternion().fromArray(aircraft.orientation);
    const eye = COCKPIT_EYE.clone().applyQuaternion(orientation).add(new THREE.Vector3().fromArray(aircraft.position));
    this.camera.position.copy(eye);
    this.camera.quaternion.copy(orientation).multiply(NOSE_FORWARD);
    this.cameraInitialized = true;
  }

  /**
   * Projects a world point into normalised screen space.
   *
   * Returns 0..1 across the viewport with y measured downward, plus whether the
   * point is behind the camera -- which the overlay needs, because a point
   * behind you projects to a mirrored position that would otherwise be drawn as
   * though it were in front.
   */
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
