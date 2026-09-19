import type { ControlInput } from "../sim/types";
import { clamp } from "../math";

export const MANEUVERS = [
  "pure_pursuit",
  "lead_pursuit",
  "lag_pursuit",
  "break_left",
  "break_right",
  "high_yoyo",
  "low_yoyo",
  "vertical_reversal",
  "defensive_spiral",
  "extend",
  "climb",
  "dive",
  "level",
] as const;

export type Maneuver = (typeof MANEUVERS)[number];

export const THROTTLE_DETENTS = ["idle", "cruise", "mil", "ab"] as const;
export type ThrottleDetent = (typeof THROTTLE_DETENTS)[number];

export const THROTTLE_VALUES: Record<ThrottleDetent, number> = {
  idle: 0,
  cruise: 0.55,
  mil: 0.85,
  ab: 1,
};

/** Stick and throttle, flown as given and held until the next answer. */
export interface RawAction {
  schema: "raw";
  controls: ControlInput;
}

export interface TacticalAction {
  schema: "tactical";
  maneuver: Maneuver;
  targetG: number;
  throttle: ThrottleDetent;
  throttleFraction?: number;
  fire: boolean;
}

export type AgentAction = RawAction | TacticalAction;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function validateAction(value: unknown): AgentAction {
  const record = (value ?? {}) as Record<string, unknown>;
  const controls = record["controls"] as Record<string, unknown> | undefined;

  if (record["schema"] === "raw" || (record["schema"] === undefined && controls !== undefined)) {
    return {
      schema: "raw",
      controls: {
        pitch: clamp(finite(controls?.["pitch"], 0), -1, 1),
        roll: clamp(finite(controls?.["roll"], 0), -1, 1),
        yaw: clamp(finite(controls?.["yaw"], 0), -1, 1),
        throttle: clamp(finite(controls?.["throttle"], 0.85), 0, 1),
        fire: controls?.["fire"] === true,
      },
    };
  }

  const maneuver = MANEUVERS.includes(record["maneuver"] as Maneuver)
    ? (record["maneuver"] as Maneuver)
    : "level";
  const throttle = THROTTLE_DETENTS.includes(record["throttle"] as ThrottleDetent)
    ? (record["throttle"] as ThrottleDetent)
    : "mil";
  const fraction = record["throttleFraction"];
  return {
    schema: "tactical",
    maneuver,
    targetG: clamp(finite(record["targetG"], 4), 1, 9),
    throttle,
    ...(typeof fraction === "number" && Number.isFinite(fraction)
      ? { throttleFraction: clamp(fraction, 0, 1) }
      : {}),
    fire: record["fire"] === true,
  };
}

