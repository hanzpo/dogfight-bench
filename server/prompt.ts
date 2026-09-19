import { MANEUVERS, THROTTLE_DETENTS } from "../src/agents/action";
import type { AgentObservation, GunSolution } from "../src/sim/telemetry";
import { aspect, either, signed } from "../src/format";

export const MANEUVER_GUIDE: Record<(typeof MANEUVERS)[number], string> = {
  pure_pursuit: "nose straight at the bandit; closes range fastest, overshoots easiest",
  lead_pursuit: "nose ahead of the bandit; the only manoeuvre that produces a gun solution",
  lag_pursuit: "nose behind the bandit; cuts closure and holds the control zone",
  break_left: "maximum-rate level turn to the left; the standard defensive move",
  break_right: "maximum-rate level turn to the right",
  high_yoyo: "climb out of plane to kill closure when overshooting from behind",
  low_yoyo: "descend to build speed when the bandit is pulling away",
  vertical_reversal: "pull into the vertical and come over the top; needs energy",
  defensive_spiral: "descending turn into an attacker to force an overshoot; costs altitude",
  extend: "run away from the bandit to rebuild speed and separation",
  climb: "trade speed for altitude",
  dive: "trade altitude for speed",
  level: "wings level, hold altitude",
};

export const SYSTEM_PROMPT = `You are flying an F-16C in a guns-only one-versus-one dogfight against another aircraft of exactly the same type. You choose one tactical command roughly once a second; an autopilot flies it until your next command.

How the fight is won:
- The only weapon is a 20 mm cannon with 511 rounds. It fires along the nose. You need the bandit inside about 1.5 km with your nose pointed where they WILL be, not where they are. The briefing gives you the predicted miss distance; under about 15 m is a hit.
- Energy is speed plus altitude. Specific excess power (Ps) is whether you are gaining or losing it. Pulling g costs energy; the harder the turn, the faster it drains. A jet that has run out of energy cannot turn, cannot climb and cannot run.
- Energy is a means, not the goal. A fight is won by pointing the nose, and pointing the nose costs g. Two or three g will not move it in any useful time; near corner speed, pull hard, take the angles, and unload afterwards to rebuild. Hoarding energy and never turning loses slowly instead of quickly.
- Corner speed is the slowest speed at which you can pull the full 9 g, and therefore where you turn best. Far below it you cannot generate g; far above it your turn radius is huge.
- Angle off tail near 0 means you are behind them, which is where you want to be. Near 180 means they are behind you, which is where you do not.
- If the briefing says THREATENED, the bandit has or nearly has a gun solution on you. Defend first; you cannot shoot if you are dead.
- The ground kills, and it is not flat. The TERRAIN block tells you the clearance your current flight path would leave over the next twenty seconds, how much altitude a recovery would cost, and whether that recovery still fits. When it says PULL UP, nothing in the fight is worth pressing: recover first. Flying level at a ridge is a collision that height-above-ground alone will not warn you about. Leaving the arena or going below the hard deck forfeits the match.

Pick the command that best improves your position over the next few seconds. Fire only when the predicted miss distance says the rounds will connect: ammunition is finite and a long burst at a bad angle wastes it.`;

function bar(label: string, value: number, unit = "", digits = 0): string {
  return `${label} ${value.toFixed(digits)}${unit}`;
}

/** A quantity that does not exist right now reads as absent, not as zero. */
function optional(label: string, value: number | null, unit = "", absent = "n/a"): string {
  return value === null ? `${label} ${absent}` : bar(label, value, unit);
}

export function buildBriefing(observation: AgentObservation, includeActionMenu = true): string {
  const own = observation.aircraft.find((aircraft) => aircraft.id === observation.ownshipId)!;
  const bandit = observation.aircraft.find((aircraft) => aircraft.id === observation.relative.opponentId)!;
  const relative = observation.relative;
  const gun = relative.gunSolution;

  const lines: string[] = [];
  lines.push(`TIME ${observation.simTimeS.toFixed(1)}s, ${observation.timeRemainingS.toFixed(0)}s remaining.`);

  lines.push(
    "",
    "YOU:",
    `  ${bar("speed", own.speedMps, " m/s")} (Mach ${own.mach.toFixed(2)}, corner speed ${own.cornerSpeedMps.toFixed(0)} m/s)`,
    `  ${bar("altitude", own.altitudeM, " m")}, ${bar("height above ground", own.altitudeAglM, " m")}, ${bar("climbing at", own.verticalSpeedMps, " m/s")}`,
    `  energy ${own.specificEnergyM.toFixed(0)} m, Ps ${signed(own.specificExcessPowerMps)} m/s (${either(own.specificExcessPowerMps, "gaining", "LOSING")} energy)`,
    `  pulling ${own.loadFactorG.toFixed(1)} g, ${own.availableLoadFactorG.toFixed(1)} g available, ${own.sustainedLoadFactorG.toFixed(1)} g sustainable`,
    `  ${bar("turn rate", own.turnRateDegS, " deg/s")}, ${optional("turn radius", own.turnRadiusM, " m", "flat")}, ${bar("alpha", own.angleOfAttackDeg, " deg")}${own.limiterActive ? " (AT THE LIMIT)" : ""}`,
    // Where the aeroplane already is and what the stick is already doing.
    // Without these a control input is chosen blind: the bank could be 80
    // degrees the way you are about to roll, and the stick already hard over.
    `  banked ${Math.abs(own.rollDeg).toFixed(0)} deg ${either(own.rollDeg, "right", "left")}, rolling ${Math.abs(own.rollRateDegS).toFixed(0)} deg/s ${either(own.rollRateDegS, "right", "left")}`,
    `  stick is ${own.controls.pitch >= 0 ? "aft" : "forward"} ${Math.abs(own.controls.pitch).toFixed(2)}, roll ${signed(own.controls.roll, 2)}, rudder ${signed(own.controls.yaw, 2)}, throttle ${(own.controls.throttle * 100).toFixed(0)}%`,
    `  ammo ${own.ammoRemaining}, fuel ${own.fuelKg.toFixed(0)} kg${own.afterburner ? ", afterburner lit" : ""}`,
  );
  if (own.hitsTaken > 0) {
    const damaged = Object.entries(own.subsystems)
      .filter(([, condition]) => condition < 1)
      .map(([name, condition]) => `${name} ${(condition * 100).toFixed(0)}%`)
      .join(", ");
    lines.push(`  DAMAGED: ${own.hitsTaken} hits taken, integrity ${(own.health * 100).toFixed(0)}% (${damaged})`);
  }
  if (own.departed) lines.push("  OUT OF CONTROL: the jet has departed controlled flight. Unload and recover.");

  lines.push(
    "",
    "BANDIT:",
    `  ${bar("range", relative.rangeM, " m")}, ${bar("closure", relative.closureRateMps, " m/s")}${relative.closureRateMps < 0 ? " (opening)" : ""}`,
    `  ${bar("bearing", relative.bearingDeg, " deg")} (${either(relative.bearingDeg, "right", "left")}), ${bar("elevation", relative.elevationDeg, " deg")} (${either(relative.elevationDeg, "above", "below")})`,
    `  angle off their tail ${relative.angleOffTailDeg.toFixed(0)} deg (you are ${aspect(relative.angleOffTailDeg)})`,
    `  they are ${relative.antennaTrainAngleDeg.toFixed(0)} deg off your nose; line of sight rate ${relative.lineOfSightRateDegS.toFixed(1)} deg/s`,
    `  ${bar("their speed", bandit.speedMps, " m/s")}, ${bar("their altitude", bandit.altitudeM, " m")}, ammo ${bandit.ammoRemaining}`,
    `  energy advantage ${signed(relative.energyAdvantageM)} m (${either(relative.energyAdvantageM, "yours", "THEIRS")}), altitude advantage ${relative.altitudeAdvantageM.toFixed(0)} m`,
  );
  if (bandit.hitsTaken > 0) lines.push(`  you have hit them ${bandit.hitsTaken} times; their integrity ${(bandit.health * 100).toFixed(0)}%`);

  lines.push(
    "",
    "GUNS:",
    `  predicted miss distance ${gun.predictedMissM > 2_000 ? "way off" : `${gun.predictedMissM.toFixed(0)} m`} (under 15 m hits)`,
    `  time of flight ${gun.timeOfFlightS.toFixed(2)}s, rounds ${gun.inLethalRange ? "would still be lethal" : "would NOT reach or would be spent"}`,
    `  ${gunLine(gun)}`,
  );
  if (relative.threatened) lines.push("  *** THREATENED: the bandit has a shot on you. Defend. ***");

  const terrain = own.terrain;
  lines.push(
    "",
    "TERRAIN:",
    `  ground below is ${terrain.overWater ? "water" : `land at ${terrain.groundElevationM.toFixed(0)} m`}; you are ${terrain.clearanceM.toFixed(0)} m above it`,
    terrain.minimumClearanceAheadM < terrain.clearanceM
      ? `  holding this flight path, clearance drops to ${terrain.minimumClearanceAheadM.toFixed(0)} m in ${terrain.timeToMinimumClearanceS.toFixed(0)}s (the ground is rising into you)`
      : `  holding this flight path, clearance stays at or above ${terrain.minimumClearanceAheadM.toFixed(0)} m`,
    `  a recovery to level costs ${terrain.recoveryHeightLossM.toFixed(0)} m; that leaves ${terrain.recoveryMarginM.toFixed(0)} m of margin`,
    `  highest ground within 12 km is ${terrain.highestNearbyM.toFixed(0)} m (${terrain.clearanceOverHighestNearbyM.toFixed(0)} m below you); lowest ground lies on heading ${terrain.safestHeadingDeg.toFixed(0)} deg`,
  );
  if (terrain.warning === "pull-up") {
    lines.push(
      terrain.timeToImpactS !== null
        ? `  *** PULL UP: this flight path hits the ground in ${terrain.timeToImpactS.toFixed(0)}s ***`
        : "  *** PULL UP: a recovery no longer fits in the height you have ***",
    );
  } else if (terrain.warning === "caution") {
    lines.push("  CAUTION: little room left between you and the ground.");
  }

  lines.push(
    "",
    "ARENA:",
    `  hard deck ${observation.arena.hardDeckAglM} m above ground; you are ${own.altitudeAglM.toFixed(0)} m above ground`,
    `  ${(observation.arena.distanceFromCentreM / 1000).toFixed(1)} km from centre, arena radius ${(observation.arena.radiusM / 1000).toFixed(0)} km`,
  );

  if (observation.recentEvents.length) {
    lines.push("", "SINCE YOUR LAST DECISION:");
    for (const event of observation.recentEvents.slice(-6)) {
      lines.push(`  ${event.time.toFixed(1)}s ${event.type}${event.actorId ? ` by ${event.actorId}` : ""}${event.subsystem ? ` (${event.subsystem})` : ""}${event.detail ? ` - ${event.detail}` : ""}`);
    }
  }

  if (includeActionMenu) {
    lines.push(
      "",
      "CHOOSE ONE MANOEUVRE:",
      ...MANEUVERS.map((maneuver) => `  ${maneuver}: ${MANEUVER_GUIDE[maneuver]}`),
      "",
      `Also choose targetG (1 to 9; higher turns faster and costs more energy), throttle (${THROTTLE_DETENTS.join(", ")}), and whether to fire.`,
    );
  }

  return lines.join("\n");
}

function gunLine(gun: GunSolution): string {
  if (gun.trackingSolution) return "*** YOU HAVE A GUN SOLUTION - FIRE ***";
  const bearing = `${gun.leadBearingDeg.toFixed(0)} deg ${either(gun.leadBearingDeg, "right", "left")}`;
  const elevation = `${gun.leadElevationDeg.toFixed(0)} deg ${either(gun.leadElevationDeg, "up", "down")}`;
  return `aim is ${gun.aimErrorDeg.toFixed(1)} deg off; lead is ${bearing}, ${elevation}`;
}
