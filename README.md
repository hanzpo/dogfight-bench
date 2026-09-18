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
| `src/ui/` | React viewer, flight display, leaderboard, match history, replay |
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
G1 drag curve with a published ballistic coefficient: the rate of fire ramps
with the rotor (first rounds out in 25 ms, full cadence shortly after, and the
rotor coasts so short bursts work), rounds inherit the aircraft's velocity,
dispersion is seeded, and time of flight to a kilometre is about 1.2 s.
Collision is resolved in the target's frame against six hit volumes that map to
subsystems, so a round through the intake is not the same as one through a
wingtip, and damage degrades the thing it hit.

A single lead-computing gunsight serves both the telemetry agents read and the
trigger the simulation pulls, so what a model is told about its shot is exactly
what the simulation does with it. It compensates for bullet drop, and authorises
fire only when the burst would actually connect -- the target's size plus how
far the dispersion cone has spread at that range.

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

A tactical command is a **standing order, flown continuously**, not a stick
position captured when the model answered. Resolving it once per decision and
holding it is the difference between an autopilot and a quarter-second-old
snapshot of one, and with the snapshot a gun solution can never converge. For
the same reason the trigger is gated on the live gun solution: `fire` means
"shoot when the pipper is on", which is what a pilot with a lead-computing
sight does. It applies identically to every tactical agent, so it advantages
none of them. Raw-schema agents keep direct control of the stick and trigger.

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

## The display

The interface is split along one line: what a pilot could actually see, and
what only the benchmark knows. Mixing them produces something that looks like a
cockpit and lies about what a cockpit contains.

**Flight display** is head-up green and laid out where a fighter puts it:
calibrated airspeed left, altitude right, heading across the top, throttle and
stores along the bottom. In the cockpit view (`VIEW · COCKPIT`) the pitch
ladder, horizon and flight path marker are drawn *conformally* -- each rung is
placed in the world at its own pitch angle and projected, so it lies along the
real horizon, banks with the aircraft, and is clipped to a combiner-sized field
of view rather than sprayed across the canopy. From an external view that would
be a lie, so the same information appears as a compact attitude indicator.

**Tactical overlay** is the gun symbology: a reticle marking where the rounds
will be at the bandit's range with drop included, ringed by the dispersion cone
at that range; the bandit boxed with a lead line; an arrow when they are off
screen; and a shoot cue that lights exactly when the simulation would authorise
the trigger.

The world is analytic terrain -- layered value noise with a continental mask,
ridged mountains and detail -- so there is no heightmap to ship and any point
can be sampled directly, which the flight model needs for height above ground
on every tick. It has coastline, inland water and snow above the treeline, and
three cloud decks, because altitude over featureless ground is unreadable.
Water is a floor rather than a hole: sea level is as low as anything flies.

**Observer panel** is everything else -- angle off the bandit's tail, the energy
ledger, predicted miss distance, their fuel and damage. None of that is on an
instrument in any cockpit, so it is presented as data: one plain monospace
block, in one place, with none of the head-up display's styling.

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

Playback shows the same instruments the pilot had, reconstructed from recorded
state, so a decision can be judged against what was actually on the display
rather than guessed at from outside.

## Deploying

The server serves the built viewer, so a deployment is one process:

```bash
npm ci && npm run build
DOGFIGHT_API_TOKEN=$(openssl rand -hex 24) \
DOGFIGHT_DB=/data/dogfight.sqlite \
HOST=0.0.0.0 PORT=8787 \
ANTHROPIC_API_KEY=... \
npm run server
```

| Variable | Why it matters |
|---|---|
| `DOGFIGHT_API_TOKEN` | Required to expose `/api/decide` and `/api/matches` off localhost. Without it those endpoints refuse to serve, because they spend provider credits on this server's keys. |
| `DOGFIGHT_DB` | Point at a writable volume, or results vanish on redeploy. |
| `DOGFIGHT_ALLOWED_ORIGINS` | Only needed to allow another origin to call the API. Off by default. |
| `HOST` | Defaults to `127.0.0.1`. Binding wider is what makes the server "exposed". |
| `DOGFIGHT_MAX_ROUNDS` | Ceiling on matches per `/api/matches` request. |

The leaderboard, match history and replays are public and read-only. The two
endpoints that call paid providers are not, and the server will tell you at
startup if it is exposed with providers configured and no token set.

Two things it does not do: terminate TLS, or authenticate individual users. Put
it behind a reverse proxy if either matters.

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

## The scripted baselines

`basic-pursuit` is the floor: it points at the bandit and shoots, with no
concept of energy. `energy-fighter` is the reference, and the thing that makes
it fly like a fighter is that it flies the corner. Turn performance peaks at
corner speed and falls away hard on both sides, so it spends g to bleed excess
speed and afterburner to rebuild it, and treats maximum g as something bought
for a shot rather than the default. Get that wrong in either direction and an
agent looks stupid in a specific way: too much g and it spirals down below
corner where it can neither turn nor run, too little and it sails past the
fight at twice corner with a two-kilometre turn radius.

Measured over twelve matches, both sides of every seeded scenario:

| | energy-fighter | basic-pursuit |
|---|---|---|
| Record | 11-1 | 1-11 |
| Accuracy | 5.1% | 0.7% |
| Time with a firing solution | 15.8 s | 5.0 s |

## Known gaps

- `energy-fighter` is a rule-based pilot, not a good one. It is the floor a
  model has to clear, and the benchmark has not yet been calibrated against a
  strong model.
- The Anthropic and OpenAI adapters are unit-tested against a mocked transport
  but have not been exercised against a live endpoint here; the Jev adapter
  has.
- Scoring beyond survival is simple: damage, gun time, control-zone time. It
  has not been tuned against human judgement of who actually won.
- No missiles, no countermeasures, no wingmen, no loadout.
