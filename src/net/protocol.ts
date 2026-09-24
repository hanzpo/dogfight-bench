import { z } from "zod";
import { AIRFRAME_IDS, type AirframeId } from "../sim/airframes";
import type { SimSnapshot } from "../sim/snapshot";
import type { ControlInput, Loadout, ScenarioConfig, SimEvent } from "../sim/types";

/** The two seats, in the order the simulation lists its aircraft. */
export const SEATS = ["blue-1", "red-1"] as const;
export type Seat = (typeof SEATS)[number];

export const SNAPSHOT_EVERY_TICKS = 6;
export const COUNTDOWN_MS = 3_000;
export const NAME_MAX = 20;

export interface LobbyPlayer {
  seat: Seat;
  name: string;
  airframe: AirframeId;
  ready: boolean;
  connected: boolean;
}

export type Phase = "lobby" | "countdown" | "flying" | "finished";

export type ServerMessage =
  | {
      type: "lobby";
      code: string;
      you: Seat;
      host: Seat;
      phase: Phase;
      players: LobbyPlayer[];
      weapons: Loadout;
      /** Milliseconds left before the merge, while counting down. */
      countdownMs?: number;
      /** Set once a match has been flown in this room: how it ended. */
      last?: { winner?: Seat; reason?: string };
    }
  | { type: "start"; scenario: ScenarioConfig; you: Seat }
  | {
      type: "state";
      /**
       * The match at a tick, except that `rounds` holds only the rounds fired
       * since the last one: a round flies the same everywhere once fired, so
       * each is sent once, and `roundsGone` says which have stopped since.
       */
      snapshot: SimSnapshot & { roundsGone: number[] };
      /** Events since the last message, which the snapshot leaves out. */
      events: SimEvent[];
      /** The newest tick this client's input has reached the server for. */
      ackTick: number;
    }
  | { type: "pong"; id: number; tick: number }
  | { type: "error"; message: string };

const controls = z.object({
  pitch: z.number().finite(),
  roll: z.number().finite(),
  yaw: z.number().finite(),
  throttle: z.number().finite(),
  fire: z.boolean(),
  missile: z.boolean().optional(),
  flare: z.boolean().optional(),
});

export const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), name: z.string().max(200), airframe: z.enum(AIRFRAME_IDS) }),
  z.object({ type: z.literal("choose"), airframe: z.enum(AIRFRAME_IDS) }),
  z.object({ type: z.literal("weapons"), weapons: z.enum(["guns", "fox2"]) }),
  z.object({ type: z.literal("ready"), ready: z.boolean() }),
  /** Fly these controls from this tick on. */
  z.object({ type: z.literal("input"), tick: z.number().int().nonnegative(), controls }),
  z.object({ type: z.literal("ping"), id: z.number() }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;

/** The stick and throttle held to what they can be, whatever arrived. */
export function clampControls(input: ControlInput): ControlInput {
  const unit = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    pitch: unit(input.pitch),
    roll: unit(input.roll),
    yaw: unit(input.yaw),
    throttle: Math.max(0, Math.min(1, input.throttle)),
    fire: input.fire,
    missile: input.missile ?? false,
    flare: input.flare ?? false,
  };
}

export function cleanName(name: string, fallback: string): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX);
  return trimmed || fallback;
}

/** Room codes: short, and without the letters people misread for one another. */
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

export function newRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
  return code;
}

export function isRoomCode(value: string): boolean {
  return new RegExp(`^[${CODE_LETTERS}]{${CODE_LENGTH}}$`).test(value);
}
