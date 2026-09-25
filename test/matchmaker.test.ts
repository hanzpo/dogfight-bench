import { describe, expect, it } from "vitest";
import { Matchmaker, QUICK_WAIT_MS } from "../src/net/matchmaker";

function matchmaker() {
  let next = 0;
  return new Matchmaker(() => `ROOM${++next}`);
}

describe("the quick-match matchmaker", () => {
  it("puts the first player in a room to wait and sends the next one there", () => {
    const queue = matchmaker();
    expect(queue.request("alice", 0)).toEqual({ code: "ROOM1", waiting: true });
    expect(queue.request("bob", 1_000)).toEqual({ code: "ROOM1", waiting: false });
    // The pair is made: whoever comes next starts a new room.
    expect(queue.request("carol", 2_000)).toEqual({ code: "ROOM2", waiting: true });
  });

  it("says whether someone is waiting, so the home page can say so", () => {
    const queue = matchmaker();
    expect(queue.someoneWaiting(0)).toBe(false);
    queue.request("alice", 0);
    expect(queue.someoneWaiting(1_000)).toBe(true);
    expect(queue.someoneWaiting(QUICK_WAIT_MS + 1)).toBe(false);
  });

  it("never pairs a player with themselves, however often they ask", () => {
    const queue = matchmaker();
    const first = queue.request("alice", 0);
    expect(queue.request("alice", 10)).toEqual(first);
    expect(queue.request("bob", 20)).toEqual({ code: first.code, waiting: false });
  });

  it("forgets a room nobody joined, and one whose player gave up", () => {
    const queue = matchmaker();
    queue.request("alice", 0);
    expect(queue.request("bob", QUICK_WAIT_MS + 1)).toEqual({ code: "ROOM2", waiting: true });
    queue.cancel("ROOM2");
    expect(queue.request("carol", QUICK_WAIT_MS + 2)).toEqual({ code: "ROOM3", waiting: true });
  });

  it("keeps a player who is still looking in the queue, and brings two searchers together", () => {
    const queue = matchmaker();
    const alice = queue.request("alice", 0);
    // Alice keeps asking from her room; the wait never runs out on her.
    expect(queue.request("alice", QUICK_WAIT_MS - 1, alice.code)).toEqual({ code: alice.code, waiting: true });
    expect(queue.request("alice", 2 * QUICK_WAIT_MS - 2, alice.code)).toEqual({ code: alice.code, waiting: true });
    expect(queue.someoneWaiting(2 * QUICK_WAIT_MS)).toBe(true);

    // Had her entry lapsed anyway, her asking again puts her room back in the queue, and Bob is sent there.
    const lapsed = matchmaker();
    const first = lapsed.request("alice", 0);
    expect(lapsed.request("alice", 5 * QUICK_WAIT_MS, first.code)).toEqual({ code: first.code, waiting: true });
    expect(lapsed.request("bob", 5 * QUICK_WAIT_MS + 1)).toEqual({ code: first.code, waiting: false });

    // Two searchers who ended up in rooms of their own: the next to ask again joins the other.
    const split = matchmaker();
    const carol = split.request("carol", 0);
    split.cancel(carol.code);
    const dave = split.request("dave", 10);
    expect(split.request("carol", 20, carol.code)).toEqual({ code: dave.code, waiting: false });
  });
});

