import type { Loadout } from "../sim/types";
import type { ControlScheme } from "./input/pilot-input";
import type { MatchSetup } from "./hooks/useLiveMatch";

export interface Choice<T extends string> {
  value: T;
  label: string;
  detail: string;
}

export type Opponent = "basic-pursuit" | "basic";

export const OPPONENTS: readonly Choice<Opponent>[] = [
  { value: "basic-pursuit", label: "Rookie", detail: "Chases your tail and shoots when it can. Good for learning the jet." },
  { value: "basic", label: "Veteran", detail: "Manages its energy, defends, and punishes mistakes." },
];

export const LOADOUTS: readonly Choice<Loadout>[] = [
  { value: "guns", label: "Guns only", detail: "The classic knife fight. 511 rounds of 20 mm." },
  { value: "fox2", label: "Guns + missiles", detail: "Adds two AIM-9M heat-seekers and 30 flares." },
];

export const SCHEMES: readonly Choice<ControlScheme>[] = [
  { value: "keyboard", label: "Keyboard", detail: "Fly with W A S D." },
  { value: "mouse", label: "Mouse", detail: "The mouse is the stick." },
  { value: "gamepad", label: "Gamepad", detail: "Any standard controller." },
];

export interface KeyBinding {
  keys: string[];
  action: string;
}

export const BINDINGS: Record<ControlScheme, KeyBinding[]> = {
  keyboard: [
    { keys: ["W", "S"], action: "Nose down / up" },
    { keys: ["A", "D"], action: "Roll left / right" },
    { keys: ["Q", "E"], action: "Rudder" },
    { keys: ["R", "F"], action: "Throttle up / down" },
    { keys: ["Space"], action: "Fire gun" },
    { keys: ["X"], action: "Launch missile" },
    { keys: ["C"], action: "Flares" },
  ],
  mouse: [
    { keys: ["Mouse"], action: "Pitch and roll" },
    { keys: ["Left click"], action: "Fire gun" },
    { keys: ["R", "F"], action: "Throttle up / down" },
    { keys: ["Q", "E"], action: "Rudder" },
    { keys: ["X"], action: "Launch missile" },
    { keys: ["C"], action: "Flares" },
    { keys: ["Right drag"], action: "Look around" },
  ],
  gamepad: [
    { keys: ["Right stick"], action: "Pitch and roll" },
    { keys: ["Left stick"], action: "Rudder" },
    { keys: ["RT", "LT"], action: "Throttle up / down" },
    { keys: ["RB"], action: "Fire gun" },
    { keys: ["LB"], action: "Launch missile" },
    { keys: ["B"], action: "Flares" },
  ],
};

export const GAME_KEYS: KeyBinding[] = [
  { keys: ["V"], action: "Change camera" },
  { keys: ["Esc"], action: "Pause menu" },
];

const STORAGE_KEY = "dogfight.setup";

export interface Setup {
  opponent: Opponent;
  weapons: Loadout;
  scheme: ControlScheme;
}

export const DEFAULT_SETUP: Setup = { opponent: "basic-pursuit", weapons: "guns", scheme: "keyboard" };

function pick<T extends string>(choices: readonly Choice<T>[], value: unknown, fallback: T): T {
  return choices.some((choice) => choice.value === value) ? (value as T) : fallback;
}

/** Whatever was stored or typed into the address bar, made into something flyable. */
export function readSetup(source: Record<string, unknown>): Setup {
  return {
    opponent: pick(OPPONENTS, source["opponent"], DEFAULT_SETUP.opponent),
    weapons: pick(LOADOUTS, source["weapons"], DEFAULT_SETUP.weapons),
    scheme: pick(SCHEMES, source["controls"] ?? source["scheme"], DEFAULT_SETUP.scheme),
  };
}

export function setupFromSearch(search: string): Setup {
  const params = new URLSearchParams(search);
  const stored = loadSetup();
  return readSetup({
    opponent: params.get("opponent") ?? stored.opponent,
    weapons: params.get("weapons") ?? stored.weapons,
    controls: params.get("controls") ?? stored.scheme,
  });
}

export function setupToSearch(setup: Setup): string {
  return `?${new URLSearchParams({ opponent: setup.opponent, weapons: setup.weapons, controls: setup.scheme })}`;
}

export function loadSetup(): Setup {
  try {
    return readSetup(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

export function saveSetup(setup: Setup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // Blocked storage only means the choice is not remembered.
  }
}

export function toMatchSetup(setup: Setup): MatchSetup {
  return { opponent: setup.opponent, weapons: setup.weapons, scheme: setup.scheme };
}

const INTRO_KEY = "dogfight.intro-seen";

export function introSeen(): boolean {
  try {
    return localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(INTRO_KEY, "1");
  } catch {
    // Shown again next time, which is harmless.
  }
}
