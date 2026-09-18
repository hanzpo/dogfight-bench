# Dogfight Bench

A browser-based benchmark in which AI models fly F-16s against each other, guns
only, from a neutral merge. Both sides get perfect-information telemetry, the
same airframe and the same flight-control system; the only thing being measured
is the quality of the decisions.

```bash
npm install
npm run server     # benchmark server: providers, matches, results  (port 8787)
npm run dev        # viewer                                        (port 5173)
```

Then open the viewer. Nothing needs an API key until you want a model to fly.

## What is here

| | |
|---|---|
| `src/sim/` | The simulation: 6-DOF flight model, ballistics, damage, scoring |
| `src/agents/` | The action schema, the tactical autopilot, scripted baselines |
| `src/ui/` | React viewer, HUD, leaderboard, match history, replay playback |
| `server/` | Provider adapters, match runner, SQLite results, HTTP API |
| `test/` | Envelope validation, conventions, ballistics, agents, replays |
| `tools/ui-check/` | Playwright browser check (Chromium + WebKit, 1x and 2x) |
| `tools/browser-feedback/` | Jev-driven agentic browser test loop |

## The simulation

Fixed 120 Hz, deterministic from a seed, and independent of the renderer.

**Flight model.** Six-degree-of-freedom rigid-body dynamics: aerodynamic
coefficients built up from a lift curve through CL_max with post-stall decay,
transonic wave drag, Mach-dependent induced drag, ground effect and sideslip
drag; Euler's equations with a full inertia tensor including the Ixz coupling;
an F110-GE-129 model with spool dynamics, afterburner lag, installed thrust
lapse and fuel burn that changes mass and inertia.

**Flight controls.** The pilot never touches a surface. Longitudinal stick is a
load-factor command, lateral stick is a roll-rate command, the pedals command
sideslip. The laws are gain-scheduled on dynamic pressure and resolve the g
command through an angle-of-attack command, so the limiter is inherent: full
aft stick at any speed gives you everything the jet has and never departs.

**How accurate is it?** Every number below is pinned by `test/flight-envelope.test.ts`
against published F-16C figures, with tolerance. If a change moves the jet
outside these bands, the tests fail.

| | Model | Published |
|---|---|---|
| Sustained turn, sea level | 20.0 deg/s | ~18-20 |
| Sustained turn, 4,500 m | 13.1 deg/s | ~12-15 |
| Instantaneous turn, 1,500 m | 27.2 deg/s at 9 g | ~26 |
| Corner speed, 1,500 m | 185 m/s | ~170-200 |
| Specific excess power, 1 g, M0.9, SL | 252 m/s | 700-900 ft/s |
| Max level speed, 11 km | Mach 1.9 | Mach 2 class |
| Roll rate | 308 deg/s (limited) | ~308 |

It is not a study simulator and does not claim to be: the aerodynamics are a
smooth analytic fit rather than the original lookup tables, and there is no
control-surface aeroelasticity, no spin modelling beyond departure onset, and
no store loadout. What it is, is falsifiable.

**Guns.** The M61A1 with 511 rounds, modelled as individual projectiles on the
G1 drag curve with a published ballistic coefficient: barrel spin-up, inherited
aircraft velocity, seeded dispersion, and roughly 1.2 s time of flight to a
kilometre. Collision is resolved in the target's frame against six hit volumes
that map to subsystems, so a round through the intake is not the same as one
through a wingtip, and damage degrades the thing it hit.

**Rules.** Terrain impact, a hard deck, arena bounds, bingo fuel, departure and
recovery. A match that runs out of clock is decided on damage dealt, then time
with a gun solution, then time in the control zone -- two passive models do not
get to draw.

## The action schema

Agents speak one of two schemas. Both drive the same airframe through the same
flight-control system.

```ts
// tactical - for models that decide a few times a second
{ schema: "tactical",
  maneuver: "lead_pursuit" | "lag_pursuit" | "high_yoyo" | "defensive_spiral" | ...,
  targetG: 1..9, throttle: "idle" | "cruise" | "mil" | "ab", fire: boolean }

// raw - for controllers that run at simulation rate
{ schema: "raw", controls: { pitch, roll, yaw, throttle, fire } }
```

A manoeuvre is a *goal for the velocity vector*, not a scripted animation. The
autopilot works out the acceleration that goal needs -- centripetal toward the
target plus the one g that holds the flight path up -- and points the lift
vector at it. Choosing the wrong goal still loses the fight.

The autopilot includes an automatic ground-collision recovery, as the real
aircraft does. Without one, every scripted match ended in a crash within thirty
seconds and not a single round was fired. It blends in rather than snatching,
so a model can still fly itself into the ground.

## Running models

Credentials live in the server process and never reach the browser; a test
(`test/isolation.test.ts`) fails the build if anything under `src/` imports
server code, names a credential, or pulls in a provider SDK.

```bash
export ANTHROPIC_API_KEY=...      # Claude
export OPENAI_API_KEY=...         # or any OpenAI-compatible endpoint
export OPENAI_BASE_URL=...        #   e.g. Groq, OpenRouter, vLLM, Ollama
export TYPESAFE_API_KEY=...       # Jev

npm run bench -- --blue anthropic --red energy-fighter --rounds 5
```

Each round flies a seeded scenario variant twice with the sides swapped, since
one symmetric merge mostly measures who happened to win the first pass. Results
go to SQLite and show up on the leaderboard.

**Claude** is asked for a structured output, so a malformed decision is a
provider error rather than a silently misflown manoeuvre. **Jev** is a
different shape of model: a classifier that returns calibrated probabilities
over choices you define, which happens to be exactly the shape of the tactical
action space, so a decision is one request with four questions and the trigger
is gated on the model's own confidence rather than a bare argmax.

Decisions have a wall-clock deadline and an inference budget. A model that
misses its deadline holds its last command and is charged a timeout; one that
blows its budget forfeits. Every decision is priced as it happens.

## Telemetry

Both agents see both aircraft in full: position, attitude as a quaternion,
velocity and acceleration, angle of attack, sideslip, body rates, load factor
and what is available and sustainable, specific energy and specific excess
power, turn rate and radius, fuel, ammunition, per-subsystem damage, and the
arena boundaries.

The relative picture includes range, closure, bearing, elevation, angle off
tail, line-of-sight rate, energy advantage, whether the opponent has a shot on
you, and a full gun solution -- including **predicted miss distance**, which is
the number that decides whether a burst connects. An aim error of two degrees
sounds tight and is a forty-metre miss at a kilometre.

## Replays

A replay holds a frame stream for playback *and* every decision an agent made.
Attaching `ReplayAgent` in place of the original agents reproduces a headless
match bit-for-bit, with no API keys, no inference spend and no requirement that
the model still exists -- so a published result can be checked by anyone.

Real-time matches replay only approximately, because a model's answer lands
whenever the network returns it rather than on the tick it was asked for.
`runHeadless` is the reproducible mode.

## Checks

```bash
npm test          # simulation, agents, ballistics, replays, asset, isolation
npm run build     # typecheck and production bundle
npm run check:ui  # browser check (needs npm run dev + npm run server)
```

`check:ui` runs the **default** live view at widescreen size in Chromium and
WebKit, at device pixel ratio 1 and 2, and fails on measured framing: the
aircraft must be centred and unclipped, and the canvas must match the window.
This is deliberate. A camera regression once shipped after being "verified"
against a paused, narrow, non-default view in one engine at one pixel ratio;
the aircraft ended up clipped into the corner on a real Retina display and only
a user's screenshot caught it.

`tools/browser-feedback/` is a separate, agentic loop: Jev drives the real
controls and the harness then verifies the resulting state independently. It
needs a TypeSafe key and Chrome remote debugging. See its README.

## Conventions

The world is right-handed with **+y up**, which forces **+z south**: with y up
and a right-handed basis, +z cannot also be north. Compass heading is therefore
`180 - yaw`.

The supplied glTF asset follows the glTF orientation rule, so the aircraft's
nose is **+z**, its canopy is **+y**, and **+x is its left**. Aerodynamics are
computed in the standard aerospace triad derived from that basis.

These are pinned by `test/conventions.test.ts` and `test/asset.test.ts`,
because a flipped sign here produces an aircraft that flies beautifully and
turns the wrong way -- the hardest kind of bug to see. If you re-export the
mesh from `F16_Clean.blend`, those tests are what tell you whether the export
orientation still matches the simulation.

## Known gaps

- The scripted baselines are mediocre pilots. That is deliberate -- they are
  the floor and the reference, not a target -- but it means a strong model has
  a lot of headroom and the benchmark has not yet been calibrated against one.
- The Anthropic and OpenAI adapters are unit-tested against a mocked transport
  but have not been exercised against a live endpoint here; the Jev adapter
  has.
- Scoring beyond survival is simple: damage, gun time, control-zone time. It
  has not been tuned against human judgement of who actually won.
- No missiles, no countermeasures, no wingmen, no loadout.
