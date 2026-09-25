import { newRoomCode } from "./protocol";

/** How long a quick-match room waits for someone to join it before it is forgotten. */
export const QUICK_WAIT_MS = 60_000;

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

  request(session: string, nowMs: number): { code: string; waiting: boolean } {
    const open = this.waiting && nowMs - this.waiting.since < QUICK_WAIT_MS ? this.waiting : undefined;
    if (open && open.session === session) return { code: open.code, waiting: true };
    if (open) {
      this.waiting = undefined;
      return { code: open.code, waiting: false };
    }
    const code = this.makeCode();
    this.waiting = { code, session, since: nowMs };
    return { code, waiting: true };
  }

  /** The waiting player gave up: nobody else should be sent to their empty room. */
  cancel(code: string): void {
    if (this.waiting?.code === code) this.waiting = undefined;
  }
}
