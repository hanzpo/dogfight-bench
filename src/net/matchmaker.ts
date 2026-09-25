import { newRoomCode } from "./protocol";

/**
 * How long a quick-match room stays in the queue without its player asking
 * again. A player still looking asks every `QUICK_STAY_MS`, so it only runs
 * out for one who has gone.
 */
export const QUICK_WAIT_MS = 60_000;
export const QUICK_STAY_MS = 20_000;

/**
 * Pairs up quick-match players: the first gets a new room and waits in it,
 * the next is sent to the same room.
 *
 * It knows who is asking, by the tab's session, so a player who asks twice --
 * a double click, a remount, a retry -- gets their own room back rather than
 * being paired with themselves and leaving the next player waiting alone.
 */
export class Matchmaker {
  private waiting?: { code: string; session: string; since: number };

  constructor(private readonly makeCode: () => string = newRoomCode) {}

  /**
   * A player looking for a match. `current` is the room they are already
   * waiting in, when they ask again to stay in the queue: a player still
   * looking after the wait runs out is put back rather than forgotten, and
   * one who finds someone else waiting is sent to them.
   */
  request(session: string, nowMs: number, current?: string): { code: string; waiting: boolean } {
    const open = this.waiting && nowMs - this.waiting.since < QUICK_WAIT_MS ? this.waiting : undefined;
    if (open && open.session === session) {
      open.since = nowMs;
      return { code: open.code, waiting: true };
    }
    if (open && open.code !== current) {
      this.waiting = undefined;
      return { code: open.code, waiting: false };
    }
    const code = current ?? this.makeCode();
    this.waiting = { code, session, since: nowMs };
    return { code, waiting: true };
  }

  /** Whether someone is waiting now: a quick match started this moment would begin at once. */
  someoneWaiting(nowMs: number): boolean {
    return this.waiting !== undefined && nowMs - this.waiting.since < QUICK_WAIT_MS;
  }

  /** The waiting player gave up: nobody else should be sent to their empty room. */
  cancel(code: string): void {
    if (this.waiting?.code === code) this.waiting = undefined;
  }
}
