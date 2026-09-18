import type { ControlInput } from "../../sim/types";

/**
 * Human control, from whatever the person is actually holding.
 *
 * Three schemes share one path into the simulation, because the aircraft has
 * exactly one set of controls and the flight model must not be able to tell
 * which device moved them. Keyboard input is always live and additive, so a
 * mouse or pad pilot can still reach for the rudder keys without switching
 * modes.
 */

export type ControlScheme = "keyboard" | "mouse" | "gamepad";

/**
 * How the mouse is being read.
 *
 * `relative` needs the pointer captured: movement accumulates into a stick that
 * stays where it is put, the mouse cannot leave the window, and it is the
 * better of the two by a distance. `absolute` is the fallback, deflecting the
 * stick by how far the visible cursor sits from the centre of the viewport. It
 * needs no permission and no focused window, which matters because pointer lock
 * is refused outright in embedded frames, in some kiosk contexts, and in every
 * automated browser -- so this is also the only mode the tests can exercise.
 */
export type MouseMode = "relative" | "absolute";

export const CONTROL_SCHEMES: readonly ControlScheme[] = ["keyboard", "mouse", "gamepad"];

/**
 * Keyboard axes, as pairs of [positive, negative].
 *
 * Pitch follows the stick, not the camera: W is forward on the stick and puts
 * the nose down, S is back and pulls. The control input is a load-factor
 * command where positive pulls, so W maps to the negative end.
 */
const KEY_AXES = {
  pitch: ["KeyS", "KeyW"],
  roll: ["KeyD", "KeyA"],
  yaw: ["KeyE", "KeyQ"],
  throttle: ["KeyR", "KeyF"],
} as const;

/** Keys the page must not hand to the browser while someone is flying. */
const SWALLOWED_KEYS = new Set(["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export interface PilotInputSettings {
  /**
   * Pixels of mouse movement for full stick deflection. Lower is twitchier.
   *
   * A real stick is about 100 mm of travel; this is the screen-space
   * equivalent, and the default is deliberately long because a gun solution is
   * won by small corrections.
   */
  mousePixelsForFullDeflection: number;
  /** Moving the mouse forward pushes the nose down, as a stick does. */
  invertMousePitch: boolean;
  /**
   * How fast the virtual stick returns to centre, in deflections per second.
   *
   * Zero leaves it where it was put, which is what a real stick does and what
   * makes a sustained turn possible without holding the mouse at the edge of
   * the mat. A little spring helps people who expect a mouse to recentre.
   */
  mouseSpringPerSecond: number;
  /** Fraction of a gamepad stick's travel ignored around centre. */
  gamepadDeadzone: number;
}

export const DEFAULT_SETTINGS: PilotInputSettings = {
  mousePixelsForFullDeflection: 420,
  invertMousePitch: false,
  mouseSpringPerSecond: 0,
  gamepadDeadzone: 0.12,
};

const SETTINGS_KEY = "dogfight.input";

export function loadSettings(): PilotInputSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<PilotInputSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: PilotInputSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing and blocked storage are not errors worth surfacing.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Deadzone plus a squared response.
 *
 * A linear pad stick makes fine tracking nearly impossible: half deflection is
 * half the g, and the last two degrees of aim need a tenth of that. Squaring
 * keeps the full range while putting most of the resolution near centre.
 */
function padCurve(value: number, deadzone: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * scaled * scaled;
}

export interface PilotInputStatus {
  scheme: ControlScheme;
  /** Virtual stick deflection, -1..1 on each axis, for the control indicator. */
  stick: { x: number; y: number };
  rudder: number;
  pointerLocked: boolean;
  mouseMode: MouseMode;
  gamepadName: string | undefined;
}

/**
 * Reads every attached device and produces one set of controls per frame.
 *
 * Deliberately not a React hook. It is sampled from the simulation's animation
 * loop at frame rate, and anything that re-rendered the page to report a stick
 * position would cost more than the simulation it is steering.
 */
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
  /** Camera movement asked for with the right button and the wheel. */
  private readonly viewDelta = { orbitX: 0, orbitY: 0, zoom: 0 };
  private orbiting = false;
  private readonly lastClient = { x: Number.NaN, y: Number.NaN };
  /** Last cursor position in client pixels, for the uncaptured mouse mode. */
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

  /** True when the pointer could be captured but has not been. */
  get canCapturePointer(): boolean {
    return this.scheme === "mouse" && !this.locked && !this.captureRefused;
  }

  /** True when the browser refused to hand over the pointer. */
  get captureUnavailable(): boolean {
    return this.captureRefused;
  }

  /**
   * Binds every listener and returns the function that removes them all.
   *
   * Keyboard and gamepad listen on the window so that flying does not depend on
   * what happens to have focus; the pointer is captured on the element the
   * person clicked, which must be the viewport.
   */
  attach(target: HTMLElement): () => void {
    this.target = target;

    const down = (event: KeyboardEvent) => {
      if (SWALLOWED_KEYS.has(event.code)) event.preventDefault();
      this.keys.add(event.code);
    };
    const up = (event: KeyboardEvent) => this.keys.delete(event.code);
    // A lost window takes every held key with it, otherwise the aircraft flies
    // away with the stick pinned.
    const blur = () => {
      this.keys.clear();
      this.mouseFiring = false;
    };

    const move = (event: MouseEvent) => {
      // Pointer lock can deliver a very large delta after a window switch.
      const dx = this.locked
        ? clamp(event.movementX, -200, 200)
        : Number.isNaN(this.lastClient.x)
          ? 0
          : event.clientX - this.lastClient.x;
      const dy = this.locked
        ? clamp(event.movementY, -200, 200)
        : Number.isNaN(this.lastClient.y)
          ? 0
          : event.clientY - this.lastClient.y;
      this.lastClient.x = event.clientX;
      this.lastClient.y = event.clientY;
      this.pointer.x = event.clientX;
      this.pointer.y = event.clientY;

      // Holding the right button looks at the aircraft instead of flying it.
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
      // Uncaptured, the buttons still work, but only over the viewport: the
      // rest of the page has selects and buttons that must stay clickable.
      if (!this.locked && !(event.target instanceof Node && target.contains(event.target))) return;
      if (event.button === 0) this.mouseFiring = true;
      if (event.button === 2) {
        this.orbiting = true;
        event.preventDefault();
      }
      // The middle button recentres the stick: the virtual equivalent of
      // letting go, and the only way back to neutral when there is no spring.
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
      // Right-drag is the camera while flying with the mouse, so the menu that
      // would otherwise appear on release has to be suppressed.
      if (this.scheme === "mouse" && event.target instanceof Node && target.contains(event.target)) {
        event.preventDefault();
      }
    };
    const wheel = (event: WheelEvent) => {
      if (this.scheme !== "mouse") return;
      if (!this.locked && !(event.target instanceof Node && target.contains(event.target))) return;
      event.preventDefault();
      this.viewDelta.zoom += event.deltaY;
    };

    const lockChanged = () => {
      const wasLocked = this.locked;
      this.locked = document.pointerLockElement === target;
      // Take the stick at neutral. Without this it starts wherever the cursor
      // happened to be relative to centre, which is a hard turn as often as not.
      if (this.locked && !wasLocked) {
        this.stick.x = 0;
        this.stick.y = 0;
      }
      if (!this.locked) {
        this.mouseFiring = false;
        // Releasing the pointer should not leave the aircraft in a turn nobody
        // is holding any more.
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

  /**
   * Captures the pointer, which the mouse scheme cannot work without.
   *
   * Must be called from a user gesture. Older WebKit returns undefined rather
   * than a promise, so the result is normalised before anything awaits it.
   */
  async requestPointerLock(): Promise<boolean> {
    if (!this.target || this.locked) return this.locked;
    try {
      await Promise.resolve(this.target.requestPointerLock());
      this.captureRefused = false;
      return true;
    } catch {
      // Refused: stay in the uncaptured mode rather than leaving the pilot with
      // no mouse control at all.
      this.captureRefused = true;
      return false;
    }
  }

  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Discards any held stick, so a restart does not inherit the last turn. */
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

  /**
   * Camera movement requested since the last call, then cleared.
   *
   * Drained by the renderer's own loop rather than pushed, so a burst of mouse
   * events between two frames becomes one camera movement instead of several.
   */
  consumeViewDelta(): { orbitX: number; orbitY: number; zoom: number } {
    const delta = { ...this.viewDelta };
    this.viewDelta.orbitX = 0;
    this.viewDelta.orbitY = 0;
    this.viewDelta.zoom = 0;
    return delta;
  }

  /** True while the right button is held and the camera is being swung. */
  get isOrbiting(): boolean {
    return this.orbiting;
  }

  /**
   * Stick deflection from where the visible cursor is.
   *
   * Measured against the centre of the element being flown rather than the
   * window, so the fight's centre and the stick's centre are the same point.
   */
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

  /**
   * The controls for this frame.
   *
   * Axes from the different devices are summed and then clamped rather than
   * having one win, so a pad pilot nudging the rudder keys gets both. Throttle
   * is a position, not an axis: every device moves it at a rate, exactly like
   * the real quadrant.
   */
  sample(dt: number): ControlInput {
    const pad = this.scheme === "gamepad" ? this.gamepad() : undefined;
    const deadzone = this.settings.gamepadDeadzone;

    let pitch = this.keyAxis(KEY_AXES.pitch);
    let roll = this.keyAxis(KEY_AXES.roll);
    let yaw = this.keyAxis(KEY_AXES.yaw);
    let throttleRate = this.keyAxis(KEY_AXES.throttle);
    let fire = this.keys.has("Space");

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
      // Report the pad's stick on the same indicator the mouse uses.
      this.stick.x = clamp(axis(2), -1, 1);
      this.stick.y = clamp(axis(3), -1, 1);
    }

    // Idle to full in about two and a half seconds, which is roughly the real
    // throttle's travel and slow enough to hold a setting.
    this.throttle = clamp(this.throttle + throttleRate * dt * 0.4, 0, 1);

    const controls: ControlInput = {
      pitch: clamp(pitch, -1, 1),
      roll: clamp(roll, -1, 1),
      yaw: clamp(yaw, -1, 1),
      throttle: this.throttle,
      fire,
    };
    if (this.scheme === "keyboard") {
      this.stick.x = controls.roll;
      this.stick.y = controls.pitch;
    }
    return controls;
  }
}
