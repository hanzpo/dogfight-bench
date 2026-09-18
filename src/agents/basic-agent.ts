import type { AgentAdapter, AgentDecision } from "./agent";
import type { AgentObservation } from "../sim/telemetry";

/** A deliberately simple baseline: pursuit guidance plus a conservative firing gate. */
export class BasicPursuitAgent implements AgentAdapter {
  constructor(public readonly id: string) {}

  async decide(obs: AgentObservation): Promise<AgentDecision> {
    const { bearingDeg: bearing, elevationDeg: elevation, rangeM } = obs.relative;
    const bankDemand = Math.max(-1, Math.min(1, bearing / 45));
    const pitchDemand = Math.max(-0.8, Math.min(0.8, elevation / 25 + Math.abs(bankDemand) * 0.12));
    return {
      controls: {
        roll: bankDemand,
        pitch: pitchDemand,
        yaw: Math.max(-0.35, Math.min(0.35, bearing / 90)),
        throttle: 1,
        fire: rangeM < 1_350 && Math.abs(bearing) < 2.2 && Math.abs(elevation) < 2.2,
      },
      rationale: "Lead pursuit baseline",
    };
  }
}
