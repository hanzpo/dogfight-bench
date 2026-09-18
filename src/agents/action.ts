import type { ControlInput } from "../sim/types";

/**
 * The benchmark's action space.
 *
 * Two schemas exist on purpose. `raw` is normalised stick and throttle: the
 * right interface for a controller that runs at simulation rate, such as a
 * learned policy. `tactical` is a named manoeuvre plus a load factor and a
 * throttle detent, resolved by an in-simulation autopilot: the right interface
 * for a language model deciding a few times a second, which can reason about
 * "lag pursuit at 6 g" but cannot meaningfully choose a stick deflection.
 *
 * Both schemas drive the identical airframe through the identical flight
 * control system, so neither is given an advantage the other lacks.
 */

export const MANEUVERS = [
  /** Point the nose straight at the opponent. */
  "pure_pursuit",
  /** Point where the opponent will be when the rounds arrive. */
  "lead_pursuit",
  /** Aim behind the opponent to cut closure and stay in the control zone. */
  "lag_pursuit",
  /** Maximum-rate level turn away from the current heading. */
  "break_left",
  "break_right",
  /** Trade closure for position out of plane, above the turn circle. */
  "high_yoyo",
  /** Trade altitude for the speed needed to reach a target that is pulling away. */
  "low_yoyo",
  /** Pull into the vertical and reverse over the top. */
  "vertical_reversal",
  /** Descending defensive turn into the attacker. */
  "defensive_spiral",
  /** Run away and rebuild energy. */
  "extend",
  "climb",
  "dive",
  /** Wings level, hold altitude. */
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

export interface RawAction {
  schema: "raw";
  controls: ControlInput;
}

export interface TacticalAction {
  schema: "tactical";
  maneuver: Maneuver;
  /** Load factor to pull through the manoeuvre, 1 to 9. */
  targetG: number;
  throttle: ThrottleDetent;
  /**
   * Throttle as a fraction, when the agent can express one.
   *
   * The detents exist because most models are choosing from a list and "mil"
   * is a more meaningful answer than 0.85. A model that returns a calibrated
   * position on a scale can say something the four detents cannot, and
   * quantising it back down to them would throw that away. When absent the
   * detent stands.
   */
  throttleFraction?: number;
  fire: boolean;
}

export type AgentAction = RawAction | TacticalAction;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Coerces whatever a model returned into a valid action.
 *
 * Nothing here throws: a malformed action becomes a safe one, and the caller
 * decides whether to count it as a failure. A benchmark that crashes on bad
 * model output measures the harness, not the model.
 */
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

/** True when the value was already a well-formed action of either schema. */
export function isWellFormedAction(value: unknown): boolean {
  const record = (value ?? {}) as Record<string, unknown>;
  if (record["schema"] === "raw") {
    const controls = record["controls"] as Record<string, unknown> | undefined;
    return (
      controls !== undefined &&
      ["pitch", "roll", "yaw", "throttle"].every((axis) => typeof controls[axis] === "number") &&
      typeof controls["fire"] === "boolean"
    );
  }
  if (record["schema"] === "tactical") {
    return (
      MANEUVERS.includes(record["maneuver"] as Maneuver) &&
      THROTTLE_DETENTS.includes(record["throttle"] as ThrottleDetent) &&
      typeof record["targetG"] === "number" &&
      typeof record["fire"] === "boolean"
    );
  }
  return false;
}
