# Dogfight Bench

A deterministic, web-based 1v1 air-combat benchmark. The first scenario is a symmetric F-16 neutral merge with guns only, perfect-information telemetry, human controls, replay capture, and a model-neutral agent API.

## Run it

```bash
npm install
npm run dev
```

Human controls: `W/S` pitch, `A/D` roll, `Q/E` rudder, `R/F` throttle, and `Space` to fire.

## Design

- The simulation runs at a fixed 120 Hz and does not depend on the renderer.
- Agents receive the complete state of both aircraft every 250 ms by default.
- Agent calls are asynchronous; the aircraft holds its last valid command while a decision is in flight.
- Real-time mode never blocks rendering on a model. `runHeadless()` instead waits for both decisions at each decision boundary and advances the match as quickly as inference permits.
- `HttpAgent` provides a provider-neutral boundary. API keys and Jev/LLM-specific translation belong in a server process, never the browser.
- Replays contain versioned scenario data and sampled aircraft transforms for a future React leaderboard/viewer.

The flight model is intentionally approachable rather than study-sim grade: lift, induced/parasitic drag, thrust/afterburner, density with altitude, angle of attack, sideslip, stalls, G loading, and rate-limited attitude response. The M61 simulation uses individual 20 mm rounds with muzzle velocity, inherited aircraft velocity, gravity, quadratic drag, seeded dispersion, 6,000 rpm cadence, finite ammunition, and swept collision tests.

## Agent contract

Implement `AgentAdapter` from `src/agents/agent.ts`, or expose an HTTP endpoint consumed by `HttpAgent`. All providers receive the same `AgentObservation` and must return:

```json
{
  "controls": {
    "pitch": 0.0,
    "roll": 0.0,
    "yaw": 0.0,
    "throttle": 1.0,
    "fire": false
  }
}
```

Stick axes are normalized to `[-1, 1]`; throttle is `[0, 1]`. Invalid values are clamped, and invalid responses hold the previous command.
