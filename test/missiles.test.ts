import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { FLARE, MISSILE } from "../src/sim/config";
import { applyBlast, createDamageState, isDestroyed } from "../src/sim/damage";
import { commandedPower } from "../src/sim/engine";
import { ReplayRecorder, parseReplay } from "../src/sim/replay";
import { rwrContacts } from "../src/sim/rwr";
import { fox2Merge, neutralMerge } from "../src/sim/scenario";
import { DogfightSimulation } from "../src/sim/simulation";
import { EnergyFighterAgent } from "../src/agents/baselines";
import type { AircraftState, ScenarioConfig } from "../src/sim/types";

const ALTITUDE_M = 6_000;

/** Puts an aircraft somewhere, level, pointing along a compass heading (0 is +z). */
function place(aircraft: AircraftState, position: Vector3, headingDeg: number, throttle = 0.85): void {
  const yaw = (headingDeg * Math.PI) / 180;
  aircraft.position.copy(position);
  aircraft.orientation.copy(new Quaternion().setFromEuler(new Euler(-aircraft.aoaRad, yaw, 0, "YXZ")));
  aircraft.velocity.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(250);
  aircraft.controls.throttle = throttle;
  aircraft.commandedControls = { ...aircraft.commandedControls, throttle };
  aircraft.engine.power = commandedPower(throttle);
}

/**
 * Blue at the origin heading +z, red `rangeM` ahead of it.
 *
 * `aspectDeg` is red's heading, so 0 is flying away from blue -- blue looking
 * up its tailpipe -- and 180 is coming straight at it.
 */
function engagement(
  rangeM: number,
  aspectDeg: number,
  options: { throttle?: number; seed?: number; config?: ScenarioConfig } = {},
) {
  const sim = new DogfightSimulation({ ...(options.config ?? fox2Merge), seed: options.seed ?? 1, maxTime: 60 });
  const [blue, red] = sim.state.aircraft as [AircraftState, AircraftState];
  place(blue, new Vector3(0, ALTITUDE_M, 0), 0);
  place(red, new Vector3(0, ALTITUDE_M, rangeM), aspectDeg, options.throttle ?? 0.85);
  return { sim, blue, red };
}

function press(aircraft: AircraftState, control: "missile" | "flare", held: boolean): void {
  aircraft.commandedControls = { ...aircraft.commandedControls, [control]: held };
}

function run(sim: DogfightSimulation, seconds: number, each?: () => void): void {
  const until = sim.state.time + seconds;
  while (sim.state.time < until && !sim.state.finished) {
    each?.();
    sim.step();
  }
}

/** Launches once and flies until the missile is gone one way or another. */
function shoot(sim: DogfightSimulation, shooter: AircraftState, each?: () => void): void {
  run(sim, 0.1);
  press(shooter, "missile", true);
  run(sim, 0.1);
  press(shooter, "missile", false);
  const until = sim.state.time + 45;
  while (sim.state.missiles.length && !sim.state.finished && sim.state.time < until) {
    each?.();
    sim.step();
  }
}

function eventsOf(sim: DogfightSimulation, type: string) {
  return sim.state.events.filter((event) => event.type === type);
}

describe("the loadout", () => {
  it("carries nothing but the gun unless the scenario says fox2", () => {
    const { sim, blue } = engagement(3_000, 0, { config: neutralMerge });
    expect(blue.stores.missiles).toBe(0);
    expect(blue.stores.flares).toBe(0);
    press(blue, "missile", true);
    press(blue, "flare", true);
    run(sim, 1);
    expect(blue.seeker.tone).toBe("off");
    expect(sim.state.missiles).toHaveLength(0);
    expect(sim.state.flares).toHaveLength(0);
  });

  it("carries two missiles and a full dispenser in a fox2 fight", () => {
    const { blue } = engagement(3_000, 0);
    expect(blue.stores.missiles).toBe(MISSILE.carried);
    expect(blue.stores.flares).toBe(FLARE.carried);
  });
});

describe("the seeker", () => {
  it("locks a tailpipe at three kilometres", () => {
    const { sim, blue } = engagement(3_000, 0);
    run(sim, 0.1);
    expect(blue.seeker.tone).toBe("lock");
    expect(blue.seeker.targetId).toBe("red-1");
  });

  it("cannot see a nose at six kilometres, though it sees a tail there", () => {
    const headOn = engagement(6_000, 180);
    run(headOn.sim, 0.1);
    expect(headOn.blue.seeker.tone).not.toBe("lock");

    const astern = engagement(6_000, 0);
    run(astern.sim, 0.1);
    expect(astern.blue.seeker.tone).toBe("lock");
  });

  it("sees a jet in afterburner far further than one at idle", () => {
    const burner = engagement(10_000, 0, { throttle: 1 });
    run(burner.sim, 0.1);
    expect(burner.blue.seeker.tone).toBe("lock");

    const idle = engagement(10_000, 0, { throttle: 0 });
    run(idle.sim, 0.1);
    expect(idle.blue.seeker.tone).not.toBe("lock");
  });

  it("has to be pointed at the bandit to acquire, and then holds it off the nose", () => {
    const { sim, blue, red } = engagement(3_000, 0);
    // Twenty degrees off the nose: outside the acquisition cone.
    red.position.set(3_000 * Math.sin(0.35), ALTITUDE_M, 3_000 * Math.cos(0.35));
    run(sim, 0.1);
    expect(blue.seeker.tone).not.toBe("lock");

    red.position.set(0, ALTITUDE_M, 3_000);
    run(sim, 0.1);
    expect(blue.seeker.tone).toBe("lock");

    red.position.set(3_000 * Math.sin(0.35), ALTITUDE_M, 3_000 * Math.cos(0.35));
    run(sim, 0.1);
    expect(blue.seeker.tone).toBe("lock");
  });
});

describe("the pickle button", () => {
  it("launches one missile per press, and only as many as are carried", () => {
    const { sim, blue } = engagement(3_000, 0);
    press(blue, "missile", true);
    run(sim, 2);
    expect(eventsOf(sim, "missile-launch")).toHaveLength(1);

    press(blue, "missile", false);
    run(sim, 0.1);
    press(blue, "missile", true);
    run(sim, 0.1);
    press(blue, "missile", false);
    run(sim, 0.1);
    press(blue, "missile", true);
    run(sim, 0.1);
    expect(eventsOf(sim, "missile-launch")).toHaveLength(2);
    expect(blue.stores.missiles).toBe(0);
    expect(blue.seeker.tone).toBe("off");
  });
});

describe("the missile", () => {
  it("kills a jet flying straight from three kilometres astern, by proximity fuze", () => {
    const { sim, blue, red } = engagement(3_000, 0);
    shoot(sim, blue);
    const burst = eventsOf(sim, "missile-detonation")[0];
    expect(burst?.targetId).toBe("red-1");
    expect(Number(/([\d.]+) m/.exec(burst?.detail ?? "")?.[1])).toBeLessThanOrEqual(MISSILE.fuzeRadiusM);
    expect(red.alive).toBe(false);
    expect(red.destroyedBy).toBe("blue-1");
    expect(sim.summary().aircraft[0]?.missilesFired).toBe(1);
  });

  it("cannot catch a jet running away from twelve kilometres", () => {
    const { sim, blue, red } = engagement(12_000, 0, { throttle: 1 });
    shoot(sim, blue);
    expect(red.alive).toBe(true);
    expect(eventsOf(sim, "missile-expired").length + eventsOf(sim, "missile-lost").length).toBeGreaterThan(0);
  });

  it("cannot turn with a beam crossing at a kilometre", () => {
    const { sim, blue, red } = engagement(1_000, 90);
    shoot(sim, blue);
    expect(red.alive).toBe(true);
  });

  it("slows down, so it is out-flown rather than out-lasted", () => {
    const { sim, blue } = engagement(25_000, 0);
    press(blue, "missile", true);
    let peak = 0;
    run(sim, 20, () => {
      const missile = sim.state.missiles[0];
      if (missile) peak = Math.max(peak, missile.velocity.length());
    });
    const missile = sim.state.missiles[0]!;
    expect(peak).toBeGreaterThan(700);
    expect(peak).toBeLessThan(900);
    expect(missile.velocity.length()).toBeLessThan(peak - 150);
  });
});

describe("the warhead", () => {
  const place = new Vector3(0, 0, 0);
  const right = new Vector3(-1, 0, 0);
  const up = new Vector3(0, 1, 0);
  const nose = new Vector3(0, 0, 1);

  it("takes the jet apart at two metres", () => {
    const damage = createDamageState();
    applyBlast(damage, new Vector3(0, 2, 0), place, right, up, nose, MISSILE.lethalRadiusM, 0.99);
    expect(isDestroyed(damage)).toBe(true);
  });

  it("only hurts it at the edge of the fuze's reach", () => {
    const damage = createDamageState();
    const loss = applyBlast(damage, new Vector3(0, MISSILE.fuzeRadiusM, 0), place, right, up, nose, MISSILE.lethalRadiusM, 0.99);
    expect(loss).toBeGreaterThan(0);
    expect(isDestroyed(damage)).toBe(false);
  });
});

describe("flares", () => {
  it("dispenses one salvo per press, a quarter of a second apart", () => {
    const { sim, red } = engagement(3_000, 0);
    press(red, "flare", true);
    run(sim, 0.1);
    expect(sim.state.flares).toHaveLength(1);
    run(sim, 1);
    expect(sim.state.flares).toHaveLength(FLARE.salvo);
    expect(red.stores.flares).toBe(FLARE.carried - FLARE.salvo);
    expect(eventsOf(sim, "flares")).toHaveLength(1);
  });

  it("drop away from the jet and burn out", () => {
    const { sim, red } = engagement(3_000, 0);
    press(red, "flare", true);
    run(sim, 1.5);
    const flare = sim.state.flares[0]!;
    expect(flare.position.distanceTo(red.position)).toBeGreaterThan(150);
    run(sim, FLARE.burnS);
    expect(sim.state.flares).toHaveLength(0);
  });

  it("decoy some missiles, and more of them when the jet is at idle than in afterburner", async () => {
    const survivals = async (throttle: number) => {
      let survived = 0;
      for (let seed = 1; seed <= 24; seed += 1) {
        // A turn for the event loop between shots: a minute of unbroken
        // simulation starves the test worker, and the runner loses track of it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const { sim, blue, red } = engagement(4_000, 0, { throttle, seed });
        let dispensed = false;
        shoot(sim, blue, () => {
          const missile = sim.state.missiles[0];
          const inside = missile !== undefined && missile.position.distanceTo(red.position) < 1_200;
          press(red, "flare", inside && !dispensed);
          if (inside) dispensed = true;
        });
        if (red.alive) survived += 1;
      }
      return survived;
    };
    const idle = await survivals(0.2);
    const burner = await survivals(1);
    expect(idle).toBeGreaterThan(burner);
    expect(burner).toBeGreaterThan(0);
    expect(idle).toBeLessThan(24);
    expect(eventsOf(engagement(3_000, 0).sim, "missile-decoyed")).toHaveLength(0);
    // Forty-eight shots, each flown until the missile is spent: half a minute
    // on a laptop and a good deal more on a shared CI runner.
  }, 180_000);
});

describe("the threat warner", () => {
  it("hears the bandit's radar only while its nose is on us", () => {
    const facing = engagement(8_000, 180);
    expect(rwrContacts(facing.sim.state, "blue-1")).toEqual([
      expect.objectContaining({ kind: "radar", sourceId: "red-1", level: "track" }),
    ]);

    const away = engagement(8_000, 0);
    expect(rwrContacts(away.sim.state, "blue-1")).toHaveLength(0);

    const far = engagement(20_000, 180);
    expect(rwrContacts(far.sim.state, "blue-1")[0]?.level).toBe("search");
  });

  it("warns of a missile coming, dead astern", () => {
    const { sim, blue } = engagement(3_000, 0);
    press(blue, "missile", true);
    run(sim, 1);
    const warning = rwrContacts(sim.state, "red-1").find((contact) => contact.kind === "missile");
    expect(warning).toBeDefined();
    expect(Math.abs(warning!.bearingDeg)).toBeGreaterThan(170);
    expect(warning!.timeToGoS).toBeGreaterThan(0);
  });
});

describe("replays with missiles", () => {
  it("records the missiles, the flares and the stores", () => {
    const { sim, blue, red } = engagement(3_000, 0);
    const recorder = new ReplayRecorder(sim.config, {});
    press(blue, "missile", true);
    press(red, "flare", true);
    for (let tick = 0; tick < 120; tick += 1) {
      sim.step();
      recorder.capture(sim.state);
    }
    const replay = parseReplay(recorder.toJSON());
    const last = replay.frames.at(-1)!;
    expect(last.missiles).toHaveLength(1);
    expect(last.flares?.length).toBeGreaterThan(0);
    expect(last.aircraft[0]?.m).toEqual([1, FLARE.carried, 3]);
  });

  it("still plays a version 3 replay, which has no missiles in it", () => {
    const { sim } = engagement(3_000, 0, { config: neutralMerge });
    const recorder = new ReplayRecorder(sim.config, {});
    for (let tick = 0; tick < 16; tick += 1) {
      sim.step();
      recorder.capture(sim.state);
    }
    const old = { ...JSON.parse(recorder.toJSON()), version: 3 };
    expect(() => parseReplay(JSON.stringify(old))).not.toThrow();
  });
});

describe("the energy fighter with missiles", () => {
  it("shoots when it has tone and flares when one is coming", async () => {
    const sim = new DogfightSimulation(fox2Merge, { recordDecisions: false });
    sim.attachAgent("blue-1", new EnergyFighterAgent("blue-1"));
    sim.attachAgent("red-1", new EnergyFighterAgent("red-1"));
    await sim.runHeadless();
    const launches = eventsOf(sim, "missile-launch");
    expect(launches.length).toBeGreaterThan(0);
    // Launched on a lock, never blind.
    for (const launch of launches) expect(launch.detail).toMatch(/locked/);
    expect(eventsOf(sim, "flares").length).toBeGreaterThan(0);
  }, 60_000);
});
