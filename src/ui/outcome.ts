import type { AircraftState, MatchState } from "../sim/types";

export interface Outcome {
  verdict: "won" | "lost" | "draw";
  headline: string;
  reason: string;
  stats: Array<{ label: string; value: string }>;
}

/** "an R-73", "an AIM-9M", "a Magic II": the article goes by how the name is said. */
function withArticle(name: string): string {
  return `${/^(A|E|I|O|R-)/.test(name) ? "an" : "a"} ${name}`;
}

/** Why an aircraft went down, from the player's side. */
function howItEnded(aircraft: AircraftState | undefined, you: boolean): string {
  switch (aircraft?.destroyedReason) {
    case "terrain impact":
      return you ? "You crashed." : "The enemy crashed.";
    case "hard deck violation":
      return you ? "You stayed too low." : "The enemy stayed too low.";
    case "left the arena":
      return you ? "You left the arena." : "The enemy left the arena.";
  }
  const weapon = aircraft?.destroyedWeapon;
  const pilot = aircraft?.destroyedReason === "pilot incapacitated";
  if (weapon?.kind === "missile") {
    if (you) return pilot ? `Your pilot was hit by ${withArticle(weapon.name)}.` : `Shot down by ${withArticle(weapon.name)}.`;
    return pilot ? `${weapon.name} kill. The pilot was hit.` : `${weapon.name} kill.`;
  }
  if (weapon?.kind === "gun") {
    if (you) return pilot ? "Your pilot was hit by gunfire." : "Shot down by guns.";
    return pilot ? "Guns kill. The pilot was hit." : "Guns kill.";
  }
  return you ? "You were shot down." : "The enemy went down.";
}

/** How a finished match went, for whoever flew `you`. */
export function outcomeOf(state: MatchState, you: string): Outcome {
  const mine = state.aircraft.find((aircraft) => aircraft.id === you);
  const bandit = state.aircraft.find((aircraft) => aircraft.id !== you);
  const won = state.winnerId === you;
  const verdict = state.winnerId === undefined ? "draw" : won ? "won" : "lost";
  const count = (type: string, actor: string) =>
    state.events.filter((event) => event.type === type && event.actorId === actor).length;
  const minutes = Math.floor(state.time / 60);
  const seconds = Math.floor(state.time % 60);

  const headline = verdict === "won" ? "You won" : verdict === "lost" ? "You lost" : "Draw";
  let reason: string;
  if (state.finishReason === "mutual destruction") reason = "Both jets went down.";
  else if (state.finishReason === "opponent left") reason = "The other pilot left.";
  else if (state.finishReason?.startsWith("time limit")) reason = "Time ran out. Decided on points.";
  else if (verdict === "lost") reason = howItEnded(mine, true);
  else if (verdict === "won") reason = howItEnded(bandit, false);
  else reason = state.finishReason ?? "";

  return {
    verdict,
    headline,
    reason,
    stats: [
      { label: "Time", value: `${minutes}:${String(seconds).padStart(2, "0")}` },
      { label: "Hits", value: String(count("hit", you)) },
      { label: "Hits taken", value: String(bandit ? count("hit", bandit.id) : 0) },
    ],
  };
}
