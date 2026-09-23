import type { ControlInput } from "../../sim/types";
import { clamp } from "../../math";

export type ControlScheme = "keyboard" | "mouse" | "gamepad";

export type MouseMode = "relative" | "absolute";

export const CONTROL_SCHEMES: readonly ControlScheme[] = ["keyboard", "mouse", "gamepad"];

const KEY_AXES = {
  pitch: ["KeyS", "KeyW"],
  roll: ["KeyD", "KeyA"],
  yaw: ["KeyE", "KeyQ"],
  throttle: ["KeyR", "KeyF"],
} as const;

const MISSILE_KEY = "KeyX";
const FLARE_KEY = "KeyC";

const SWALLOWED_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export interface PilotInputSettings {
  mousePixelsForFullDeflection: number;
  invertMousePitch: boolean;
  mouseSpringPerSecond: number;
  gamepadDeadzone: number;
}

export const DEFAULT_SETTINGS: PilotInputSettings = {
  mousePixelsForFullDeflection: 420,
  invertMousePitch: false,
  mouseSpringPerSecond: 0,
  gamepadDeadzone: 0.12,
};

const SETTINGS_KEY = "dogfight.input";

/** Bounds each setting, so a stored value can be wrong but never unusable. */
const SETTING_RANGE = {
  mousePixelsForFullDeflection: [40, 4_000],
  mouseSpringPerSecond: [0, 20],
  gamepadDeadzone: [0, 0.9],
} as const;

/**
 * Whatever is in storage was written by some build of this page, not
 * necessarily this one. A stored setting of the wrong type or a silly
 * magnitude would otherwise survive a release and quietly break the controls,
 * with nothing to do about it but know to clear the site's data.
 */
export function loadSettings(): PilotInputSettings {
  let stored: Partial<PilotInputSettings> = {};
  try {
    stored = (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<PilotInputSettings>) ?? {};
  } catch {
    return { ...DEFAULT_SETTINGS };
  }

  const settings = { ...DEFAULT_SETTINGS };
  if (typeof stored.invertMousePitch === "boolean") settings.invertMousePitch = stored.invertMousePitch;
  for (const [name, [low, high]] of Object.entries(SETTING_RANGE) as Array<
    [keyof typeof SETTING_RANGE, readonly [number, number]]
  >) {
    const value = stored[name];
    if (typeof value === "number" && Number.isFinite(value)) settings[name] = clamp(value, low, high);
  }
  return settings;
}

export function saveSettings(settings: PilotInputSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing and blocked storage are not errors worth surfacing.
  }
}

function padCurve(value: number, deadzone: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * scaled * scaled;
}

export interface PilotInputStatus {
  scheme: ControlScheme;
  stick: { x: number; y: number };
  rudder: number;
  pointerLocked: boolean;
  mouseMode: MouseMode;
  gamepadName: string | undefined;
}

export class PilotInput {
  settings: PilotInputSettings;
  scheme: ControlScheme = "keyboard";

  private readonly keys = new Set<string>();
  private readonly stick = { x: 0, y: 0 };
  private mouseFiring = false;
  private throttle = 0.85;
  private locked = false;
  private captureRefused = false;
  private target: HTMLElement | undefined;
  private padIndex: number | undefined;
  private readonly viewDelta = { orbitX: 0, orbitY: 0, zoom: 0 };
  private orbiting = false;
  private readonly lastClient = { x: Number.NaN, y: Number.NaN };
  private readonly pointer = { x: Number.NaN, y: Number.NaN };

  constructor(settings: PilotInputSettings = loadSettings()) {
    this.settings = settings;
  }

  get status(): PilotInputStatus {
    const pad = this.gamepad();
    return {
      scheme: this.scheme,
      stick: { ...this.stick },
      rudder: 0,
      pointerLocked: this.locked,
      mouseMode: this.mouseMode,
      gamepadName: pad?.id,
    };
  }

  get mouseMode(): MouseMode {
    return this.locked ? "relative" : "absolute";
  }

  get canCapturePointer(): boolean {
    return this.scheme === "mouse" && !this.locked && !this.captureRefused;
  }

  get captureUnavailable(): boolean {
    return this.captureRefused;
  }

  /**
   * A locked pointer reports a movement delta and never moves its client
   * coordinates; an unlocked one does the opposite. The first event after
   * attaching has no previous position to subtract.
   */
  private pointerDelta(movement: number, client: number, last: number): number {
    if (this.locked) return clamp(movement, -200, 200);
    if (Number.isNaN(last)) return 0;
    return client - last;
  }

  attach(target: HTMLElement): () => void {
    this.target = target;

    const down = (event: KeyboardEvent) => {
      if (SWALLOWED_KEYS.has(event.code)) event.preventDefault();
      this.keys.add(event.code);
    };
    const up = (event: KeyboardEvent) => this.keys.delete(event.code);
    const blur = () => {
      this.keys.clear();
      this.mouseFiring = false;
    };

    const move = (event: MouseEvent) => {
      const dx = this.pointerDelta(event.movementX, event.clientX, this.lastClient.x);
      const dy = this.pointerDelta(event.movementY, event.clientY, this.lastClient.y);
      this.lastClient.x = event.clientX;
      this.lastClient.y = event.clientY;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;

      if (this.orbiting) {
        this.viewDelta.orbitX += dx;
        this.viewDelta.orbitY += dy;
        return;
      }
      if (!this.locked) return;

      const scale = 1 / Math.max(this.settings.mousePixelsForFullDeflection, 40);
      this.stick.x = clamp(this.stick.x + dx * scale, -1, 1);
      this.stick.y = clamp(this.stick.y + dy * scale * (this.settings.invertMousePitch ? -1 : 1), -1, 1);
    };

    const mouseDown = (event: MouseEvent) => {
      if (!this.locked && !(event.target instanceof Node && target.contains(event.target))) return;
      if (event.button === 0) this.mouseFiring = true;
      if (event.button === 2) {
        this.orbiting = true;
        event.preventDefault();
      }
      if (event.button === 1) {
        this.stick.x = 0;
        this.stick.y = 0;
        event.preventDefault();
      }
    };
    const mouseUp = (event: MouseEvent) => {
      if (event.button === 0) this.mouseFiring = false;
      if (event.button === 2) this.orbiting = false;
    };
    const contextMenu = (event: MouseEvent) => {
      if (this.scheme === "mouse" && event.target instanceof Node && target.contains(event.target)) {
        event.preventDefault();
      }
    };
    const wheel = (event: WheelEvent) => {
      if (!this.locked && !(event.target instanceof Node && target.contains(event.target))) return;
      event.preventDefault();
      this.viewDelta.zoom += event.deltaY;
    };

    const lockChanged = () => {
      const wasLocked = this.locked;
      this.locked = document.pointerLockElement === target;
      if (this.locked && !wasLocked) {
        this.stick.x = 0;
        this.stick.y = 0;
      }
      if (!this.locked) {
        this.mouseFiring = false;
        if (wasLocked) {
          this.stick.x = 0;
          this.stick.y = 0;
        }
      }
    };
    const lockFailed = () => {
      this.captureRefused = true;
      this.locked = false;
    };
    const padConnected = (event: GamepadEvent) => {
      this.padIndex = event.gamepad.index;
    };
    const padDisconnected = (event: GamepadEvent) => {
      if (this.padIndex === event.gamepad.index) this.padIndex = undefined;
    };

    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    addEventListener("mousemove", move);
    addEventListener("mousedown", mouseDown);
    addEventListener("mouseup", mouseUp);
    addEventListener("contextmenu", contextMenu);
    addEventListener("wheel", wheel, { passive: false });
    addEventListener("gamepadconnected", padConnected);
    addEventListener("gamepaddisconnected", padDisconnected);
    document.addEventListener("pointerlockchange", lockChanged);
    document.addEventListener("pointerlockerror", lockFailed);

    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
      removeEventListener("mousemove", move);
      removeEventListener("mousedown", mouseDown);
      removeEventListener("mouseup", mouseUp);
      removeEventListener("contextmenu", contextMenu);
      removeEventListener("wheel", wheel);
      removeEventListener("gamepadconnected", padConnected);
      removeEventListener("gamepaddisconnected", padDisconnected);
      document.removeEventListener("pointerlockchange", lockChanged);
      document.removeEventListener("pointerlockerror", lockFailed);
      this.target = undefined;
    };
  }

  async requestPointerLock(): Promise<boolean> {
    if (!this.target || this.locked) return this.locked;
    try {
      await Promise.resolve(this.target.requestPointerLock());
      this.captureRefused = false;
      return true;
    } catch {
      this.captureRefused = true;
      return false;
    }
  }

  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  reset(): void {
    this.stick.x = 0;
    this.stick.y = 0;
    this.throttle = 0.85;
    this.mouseFiring = false;
    this.orbiting = false;
    this.viewDelta.orbitX = 0;
    this.viewDelta.orbitY = 0;
    this.viewDelta.zoom = 0;
  }

  consumeViewDelta(): { orbitX: number; orbitY: number; zoom: number } {
    const delta = { ...this.viewDelta };
    this.viewDelta.orbitX = 0;
    this.viewDelta.orbitY = 0;
    this.viewDelta.zoom = 0;
    return delta;
  }

  get isOrbiting(): boolean {
    return this.orbiting;
  }

  private readAbsolutePointer(): void {
    if (!this.target || Number.isNaN(this.pointer.x)) return;
    const box = this.target.getBoundingClientRect();
    const travel = Math.max(this.settings.mousePixelsForFullDeflection, 40);
    const invert = this.settings.invertMousePitch ? -1 : 1;
    this.stick.x = clamp((this.pointer.x - (box.left + box.width / 2)) / travel, -1, 1);
    this.stick.y = clamp(((this.pointer.y - (box.top + box.height / 2)) / travel) * invert, -1, 1);
  }

  private gamepad(): Gamepad | undefined {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return undefined;
    const pads = navigator.getGamepads();
    if (this.padIndex !== undefined) {
      const known = pads[this.padIndex];
      if (known?.connected) return known;
      this.padIndex = undefined;
    }
    for (const pad of pads) {
      if (pad?.connected) {
        this.padIndex = pad.index;
        return pad;
      }
    }
    return undefined;
  }

  private keyAxis(pair: readonly [string, string]): number {
    return (this.keys.has(pair[0]) ? 1 : 0) - (this.keys.has(pair[1]) ? 1 : 0);
  }

  sample(dt: number): ControlInput {
    const pad = this.scheme === "gamepad" ? this.gamepad() : undefined;
    const deadzone = this.settings.gamepadDeadzone;

    let pitch = this.keyAxis(KEY_AXES.pitch);
    let roll = this.keyAxis(KEY_AXES.roll);
    let yaw = this.keyAxis(KEY_AXES.yaw);
    let throttleRate = this.keyAxis(KEY_AXES.throttle);
    let fire = this.keys.has("Space");
    let missile = this.keys.has(MISSILE_KEY);
    let flare = this.keys.has(FLARE_KEY);

    if (this.scheme === "mouse") {
      if (this.locked) {
        if (this.settings.mouseSpringPerSecond > 0) {
          const decay = Math.max(0, 1 - this.settings.mouseSpringPerSecond * dt);
          this.stick.x *= decay;
          this.stick.y *= decay;
        }
      } else if (!this.orbiting) {
        this.readAbsolutePointer();
      }
      pitch += this.stick.y;
      roll += this.stick.x;
      fire ||= this.mouseFiring;
    }

    if (pad) {
      const axis = (index: number) => padCurve(pad.axes[index] ?? 0, deadzone);
      roll += axis(2);
      pitch += axis(3);
      yaw += axis(0);
      const trigger = (index: number) => pad.buttons[index]?.value ?? 0;
      throttleRate += trigger(7) - trigger(6);
      fire ||= (pad.buttons[5]?.pressed ?? false) || (pad.buttons[0]?.pressed ?? false);
      missile ||= pad.buttons[4]?.pressed ?? false;
      flare ||= pad.buttons[1]?.pressed ?? false;
      this.stick.x = clamp(axis(2), -1, 1);
      this.stick.y = clamp(axis(3), -1, 1);
    }

    this.throttle = clamp(this.throttle + throttleRate * dt * 0.4, 0, 1);

    const controls: ControlInput = {
      pitch: clamp(pitch, -1, 1),
      roll: clamp(roll, -1, 1),
      yaw: clamp(yaw, -1, 1),
      throttle: this.throttle,
      fire,
      missile,
      flare,
    };
    if (this.scheme === "keyboard") {
      this.stick.x = controls.roll;
      this.stick.y = controls.pitch;
    }
    return controls;
  }
}
