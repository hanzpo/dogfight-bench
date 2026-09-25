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
});
