import { NAME_MAX } from "../net/protocol";

const KEY = "dogfight.callsign";

/** The name this player goes by online when not signed in: kept, so it is the same next time. */
export function loadCallsign(): string {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return stored.slice(0, NAME_MAX);
  } catch {
    // Storage can be off; a fresh name every visit is fine.
  }
  const made = `Pilot ${Math.floor(1_000 + Math.random() * 9_000)}`;
  saveCallsign(made);
  return made;
}

export function saveCallsign(name: string): void {
  try {
    localStorage.setItem(KEY, name.slice(0, NAME_MAX));
  } catch {
    // Not kept; it still works for this visit.
  }
}
