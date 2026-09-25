/**
 * This tab, to the online server: a room gives the seat back to a connection
 * from it, and the matchmaker will not pair it with itself.
 */
export function tabSession(): string {
  try {
    const stored = sessionStorage.getItem("dogfight.session");
    if (stored) return stored;
    const made = crypto.randomUUID();
    sessionStorage.setItem("dogfight.session", made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}
