# Dogfight Bench

AI models fly F-16s against each other, guns only, from a neutral merge. Both
sides get perfect-information telemetry, the same airframe and the same flight
control system; the only thing measured is the quality of the decisions. You can
fly against them yourself.

**Live: https://dogfight.hanzpo.com**

```bash
npm install
npm run server     # API, providers, results        (port 8787)
npm run dev        # viewer                         (port 5173)
```

Nothing needs a key until you want a model to fly.

| | |
|---|---|
| `src/sim/` | 6-DOF flight model, ballistics, damage, terrain, scoring |
| `src/agents/` | Action schemas, the tactical autopilot, scripted baselines |
| `src/viewer/` | Three.js scene, terrain, effects, the five cameras |
| `src/ui/` | Flight display, tactical overlay, leaderboard, matches, replay |
| `server/` | Provider adapters, match runner, accounts, HTTP API |
| `worker/`, `wrangler.toml` | The same API on Cloudflare |
| `supabase/migrations/` | Results schema, Elo, housekeeping |
| `tools/ui-check/` | Browser check (Chromium + WebKit, 1x and 2x) |

## Jev

Jev is not asked to write an answer. It answers typed questions about a state,
and returns each answer already shaped, with a probability distribution and a
calibrated confidence. The adapter asks four at once, one round trip:

| Question | Primitive | Why that one |
| --- | --- | --- |
| Which manoeuvre? | `choice` | One of thirteen named things to do |
| How hard to pull? | `score` | A position on a rubric, returned continuously -- 3.4 of 4 is 7.8 g, which no menu of detents could say |
| How much thrust? | `score` | The same, mapped to throttle |
| Would a burst hit? | `noul` | A yes/no whose honest answer is a probability |

Confidence is used rather than discarded: below a threshold the previous
manoeuvre is held, because a guess is not a reason to abandon a plan mid-fight.
The distributions are drawn live in the details panel.

Two things about the mapping were worth measuring. A score is a
probability-weighted mean, so an uncertain answer lands in the middle of
whatever scale it is mapped onto: an even 1..9 g put every uncertain answer at
4 g, which in a 9 g aeroplane cannot stay inside anybody, and every merge ended
ten kilometres apart. The rubric's rungs are not evenly spaced in g, because
four of the five describe a jet that is turning and one does not. And the
trigger is asked strictly but answered generously -- demanding a perfect
solution rather than a plausible one cut the rounds fired by seventy per cent
and the hits to none.

Where that leaves it, over ten matches against `energy-fighter`: **5-5**, with
twenty-five hits and ten seconds spent with the nose on the bandit. The
scripted pilot had not been beaten once before this.

Three things got it there, and the order is not the order anyone would guess.
The manoeuvre criteria now describe *when* each manoeuvre is the answer rather
than what it does -- a `choice` matches the state against its criteria, and
written as mechanics a head-on merge read as a reason to break, which threw
away a gun solution eighteen metres from a hit. The stick moves at a finite
rate, so a command is no longer a step, and a steadier gun platform is worth
more than it sounds. And the briefing reports bank angle, roll rate and where
the controls already are, none of which it used to say.

Two changes were measured and rejected. Tightening the trigger traded
twenty-five hits for fourteen to gain one win in eight, which is a coin flip
bought with a real loss. And asking the manoeuvre in one call and then the
commitment, power and trigger in a second call conditioned on it -- which fixes
a genuine incoherence, because System One answers every question in isolation,
so "how hard through that manoeuvre" had no manoeuvre to refer to -- came out
1-7 with no hits at all from 429 rounds. Naming the plan colours the trigger,
and the trigger should be answered from the gun solution alone. The isolation
is a feature.

## Why the model names manoeuvres instead of moving the stick

The obvious design is to let the model set pitch, roll and yaw directly. It was
built and measured, and it does not work. Over the same matches against
`energy-fighter`:

| | stick | manoeuvres |
|---|---|---|
| Record | 0-4 | 2-6 |
| Hits | **0 from 1,144 rounds** | 10 from 206 |
| Time on target | 0.0 s | 1.8 s |

The failure is one column of the decision log: the roll command alternates sign
on nearly every decision. A control position chosen once a second and then held
is an open loop with a one-second dead time, so the jet rolls hard one way,
overshoots while nobody is looking, and rolls hard back. It is the ordinary
reason a language model belongs in the outer loop of a controller and not the
inner one. The autopilot behind a named manoeuvre *is* that inner loop, closing
at 120 Hz against a goal the model sets.

Five things were tried and none of them fixed it. Asking each axis as a single
signed score collapsed every axis to centre, because a score is a
probability-weighted mean and the mean of "full left" and "full right" is
"centred". Splitting each axis into a direction (`choice`, which cannot average
across its options) and a magnitude (`score`, where a mean is meaningful) gave
real signed deflections and did not stop the oscillation. Nor did running Jev
at 5 Hz, which its 180 ms latency allows; nor telling it the bank angle, roll
rate and current stick position, which the briefing had never reported; nor
rate-limiting the stick, which fixed the *look* of it completely and changed
nothing about the flying.

Two of those became permanent because they are right on their own terms: the
briefing reports attitude and where the controls already are, and the stick
moves at a finite rate. The stick interface itself is gone.

## Fox 2

Guns only is the default, and every benchmark was flown that way. The live
page can also load each jet with two AIM-9Ms and thirty flares (**Weapons ·
Guns + 2 × AIM-9M**). Launch with X or LB, dispense flares with C or B.

It is an AIM-9M and not an AIM-9X on purpose: a seeker that can look far off
the nose turns every merge into whoever gets tone first.

- **Seeker.** Before launch the seeker is slaved to the nose and sees only 6°
  around it, so you have to point at the bandit to get tone. You hear a growl
  as heat comes into view and a steady tone once it locks. After that it
  tracks on its own out to 40°. It sees a tailpipe much better than a nose,
  and afterburner better than idle. At military power it locks from about
  8 km dead astern and about 2.5 km head-on.
- **Missile.** It flies proportional navigation and bleeds speed hard when it
  turns. It loses the track past its gimbal limit or when the line of sight
  moves faster than it can follow. It bursts on a 9 m proximity fuze. Against
  a jet flying straight it reaches about 6 km from astern and about 4 km
  head-on, and a beam crossing at a kilometre beats it.
- **Flares.** One press dispenses a pair. Each flare gets one chance to pull
  the seeker, and the chance grows with how many times brighter it is than
  the jet. Against a shot from dead astern, one pair defeats about 60% of
  missiles at idle, 30% at military power and under 20% in afterburner, so
  pull the power back while you dispense. A nose is dim, so flares do much
  better against head-on shots.
- **Warning.** The RWR scope shows the bandit's radar while you are inside
  its scan, and inbound missiles by bearing. The HUD flashes the clock
  position, range and time to go.

Missile fights are not ranked; the ladder is a guns ladder. Replays record
missiles and flares (format version 4), and version 3 replays still play.
The model adapters are not told about missiles yet, so only the scripted
pilots and people use them.

## Aircraft

Eight jets, each built to win a different kind of fight rather than to beat
the others outright. All numbers are in `src/sim/airframes.ts`.

| Jet | Role | Gun | IR missile |
|---|---|---|---|
| F-16C | All-rounder | M61A1, 511 | AIM-9M |
| MiG-29A | Brawler: hardest first turn of the twins | GSh-30-1, 150 | R-60M |
| F/A-18C | Slow-speed knife fighter: 35° angle of attack | M61A1, 578 | AIM-9M |
| F-15C | Energy fighter: most thrust, climbs away | M61A1, 940 | AIM-9M |
| Su-27S | Long-haul brawler: huge fuel, hot and big | GSh-30-1, 150 | R-73 |
| Mirage 2000C | First-turn delta: brutal first turn, bleeds speed | 2× DEFA 554, 250 | Magic II |
| F-5E | Underdog: small, cool, hard to lock | 2× M39A2, 560 | AIM-9P |
| Gripen C | Precision dogfighter: quick roll, small | BK-27, 120 | AIM-9M |

Each is a flight-model spec (geometry, mass, thrust, lift and drag, g and
angle-of-attack limits, roll rate), a gun, a missile, a heat signature, hit
volumes scaled to its size, and where its nozzles, rails and cockpit are.
The flight control laws are shared. Only the F-16's aerodynamics come from
wind-tunnel data; the others are approximations fitted to published
dimensions and performance, then tuned against each other in scripted
fights. Every missile's seeker is held to roughly an AIM-9M's, so no jet
gets a helmet-sight merge.

### Models

Every jet has a model. The Mirage, Gripen, Su-27 and F-5 are built from
reference three-views by the scripts in
[`tools/models`](tools/models/README.md). If a model fails to load, the jet
is drawn as a placeholder built from its numbers. To use another model, put
a `.glb` at `public/aircraft/<id>.glb` and set `model: "/aircraft/<id>.glb"`
on the airframe. The file needs to be:

- **Oriented** nose along +z, up +y, left wing along +x, as the F-16's is.
- **Real size, in metres**, with the origin halfway along the fuselage.
- **Light-coloured `MeshStandardMaterial`s**, because the teams are shown by
  tinting them blue and red.
- **Lined up with the airframe's numbers:** `nozzles` (where afterburner
  plumes start), `rails` (where the carried missiles hang) and `cockpitEye`
  (the cockpit camera) are in body axes, right-up-nose, so move them to
  match the model or model to match them. Rails under a wing also want
  `pylonHeightM`, the gap from the missile's back to the wing, since the
  models come without pylons.

A model exported facing the other way can be left as it is: set
`modelYawDeg: 180` on the airframe and it is turned as it loads, so the
`.blend` stays the source. The F/A-18 is done this way. `test/asset.test.ts`
checks every model's centre of gravity, hit volumes, gun, cockpit, rails and
nozzles against the file, so a re-export that moves any of them fails a test
rather than hanging missiles in mid-air. A file that fails to load falls
back to the placeholder.

## Cameras

Five, because a fight asks five different questions. **Free look** is the
default; the wheel zooms in all of them.

| | |
|---|---|
| **Free look** | Hand-driven orbit. Drag to swing round the aircraft, scroll to dolly |
| **Chase** | Behind the aircraft and not rolling with it, so the horizon stays level and the airframe is the attitude instrument |
| **Target track** | On the line through both aircraft -- camera, your jet, the bandit, in that order -- so angle off and range are one picture rather than two numbers |
| **Arena** | Down on both from outside, broadside to the line between them, framing the pair while they fit |
| **Cockpit** | The pilot's eye, and the only view where the pitch ladder and flight path marker are telling the truth |

Zoom means something different in each. A view that places itself changes how
far off it stands; the free view dollies; and the cockpit narrows its field of
view, because the pilot's eye cannot move.

## Running models

```bash
export TYPESAFE_API_KEY=...       # Jev
export ANTHROPIC_API_KEY=...      # Claude
export OPENAI_API_KEY=...         # or any OpenAI-compatible endpoint

npm run bench -- --blue jev --red energy-fighter --rounds 5
```

Each round flies a seeded scenario twice with sides swapped. Decisions have a
wall-clock deadline and an inference budget; a model that misses the deadline
holds its last command, one that blows the budget forfeits.

**Who pays.** One provider is free to everyone on the deployment's own
credentials (`DOGFIGHT_PUBLIC_PROVIDERS`, default `jev`), capped daily in
dollars *and* decisions and kept in the database so a redeploy does not hand out
a fresh budget. Everything else runs on a key entered under **Model keys**,
which is used for one upstream call and dropped -- never stored, never logged,
scrubbed from errors. A provider that reports no price per call can never reach
the dollar cap, so the decision count is the real limit; the server says which
is doing the work at startup.

## Accounts and the leaderboard

Rating is Elo, and everything holds one on the same scale: models, baselines and
people. Two people beating the same model must cost it twice, which works
because a model is one competitor rather than one per opponent. A model's
identity is provider, model, policy version *and* interface -- change the prompt
and you have a new entrant, not a new rating for the old one.

Signing in is optional; it makes a result count and keeps the replay. Guests are
rated, and their wins still cost their opponent, but they are not listed.

**What a reported result is worth.** The server issues a ticket when a match
starts and counts the decisions it serves against it, so nobody can report a win
over a model it never called, and a match can only be reported once. Against a
scripted opponent the only check left is the clock. What none of it catches is
somebody flying a real match and lying about who won: a live match is not
reproducible by construction, because a decision is applied whenever the network
returns it. So `verified` records how far it was actually checked, the replay is
kept, and matches the server ran itself are reproducible from their decision log
and marked accordingly.

## Online play

The home page offers three ways to fly:

- **Quick match** pairs you with whoever else is looking, and the home page
  shows when someone is already waiting.
- **With a friend** makes a private room with a code and a link to send. A
  friend can also type the code into the home page.
- **Training** is you against the AI.

Each room is a Cloudflare Durable Object, so everyone in it reaches the same
instance. That instance runs the same `DogfightSimulation` the game runs
offline, at the same 120 Hz, and it alone decides what happens: hits, damage
and kills. Your browser keeps its own copy running a little ahead of the room,
so your jet answers the stick at once. The other jet flies on with the last
controls the room reported. About twenty times a second the room sends where
the fight really stands. Your copy goes back to that point, flies your inputs
again on top, and eases any difference into view rather than jumping to it.

- `src/net/room.ts` is the room: the lobby, the countdown, and the fight
  stepped in real time. It knows nothing of Cloudflare; `worker/rooms.ts`
  wraps it in the Durable Object.
- `src/net/client.ts` is a player's side: the prediction, the replay of your
  inputs on top of each snapshot, and a clock that keeps inputs arriving just
  before the room needs them.
- A round is sent once, when it is fired, since it flies the same everywhere
  from then on. A snapshot comes to about 4 KB, twenty times a second.
- A dropped connection doesn't end anything. The room holds the seat for
  20 seconds, with the jet flying on, and the page reconnects on its own. The
  same tab, by its session, takes the seat back, even mid-fight. Leaving
  through the page gives the seat up at once, and in a fight that concedes.
- Quick match queues one waiting player at a time. A player still searching
  asks again every 20 seconds, so the queue never forgets them, and two
  searchers who ended up in separate rooms are brought together.

`test/online.test.ts` runs whole matches in memory over a simulated network
with latency and jitter. It checks that your own jet is predicted to within
5 cm of the room, that inputs arrive in time, and that a fight ends the same
way for both players.

Locally, `npm run dev:all` starts everything in one terminal:

- the site, on :5173;
- the API server, on :8787, for the leaderboard, results and model pilots;
- the online Worker, on :8788.

Vite sends `/api/online` to the Worker and the rest of `/api` to the API
server. To run one part alone, use `npm run dev`, `dev:server` or
`dev:online`. `npm run check:online` plays two scripted pilots against the
local Worker.

## Deploying

Cloudflare Workers, with Supabase for results and replays:

```bash
npm run build && npx wrangler deploy
```

A Worker has no filesystem and `node:sqlite` refuses to construct there, so
Supabase is required. Set `SUPABASE_SERVICE_ROLE_KEY` and `TYPESAFE_API_KEY`
with `wrangler secret put`; the rest is in `wrangler.toml`. A benchmark series
is minutes of work for one request, so it is off on the Worker and stays on a
machine that can sit still.

Or as one Node process, which serves the viewer itself and falls back to a local
SQLite file:

```bash
npm run build
DOGFIGHT_API_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm run server
```

Copy `.env.example` to `.env` and the scripts read it.

| Variable | Why it matters |
|---|---|
| `DOGFIGHT_API_TOKEN` | Required to run a benchmark series off localhost; it queues unbounded paid work. |
| `DOGFIGHT_PUBLIC_PROVIDERS` | Free to everyone, up to the cap. Adding one offers its credential to the internet. |
| `DOGFIGHT_PUBLIC_DAILY_USD`, `..._DECISIONS` | What that tier may spend in a day, across everybody. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Results to Postgres, replays to object storage. The service key bypasses row level security. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Build-time, compiled into the bundle. Public values only. |
| `DOGFIGHT_DB` | SQLite path, ignored when Supabase is configured. Point at a writable volume. |

Row level security does not replace a grant: a policy says which rows, a grant
says whether the role may touch the table. Both are in the migrations.

Guest sessions, unsettled tickets and orphaned replays accumulate with nothing
to remove them; `prune_abandoned()` and `orphaned_replays()` exist for that and
need scheduling.

**Needs doing by hand:** Google and GitHub sign-in are wired up but disabled on
the project. Create an OAuth app with each, paste the client ID and secret into
Supabase → Authentication → Providers, and add the deployed origin to URL
Configuration. The callback is `https://<project>.supabase.co/auth/v1/callback`.
Anonymous sign-in is already on.

## Continuous integration

`.github/workflows/ci.yml` runs the tests, then type-checks and builds, on
every pull request and push. A push to `main` that passes is deployed to
Cloudflare, shipping the build that was tested. It needs two secrets on the
repository's `production` environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`, a token with the "Edit Cloudflare Workers" template

The Worker's own secrets (`SUPABASE_SERVICE_ROLE_KEY`, `TYPESAFE_API_KEY`) live
on the Worker and are untouched by a deploy. The browser check below needs a
running API with matches in it, so it stays a local check for now.

## Checks

```bash
npm test               # 119 tests, ~10 s
npm run build          # typecheck and bundle
npm run check:ui:fast  # one engine, ~40 s -- the loop while changing a layout
npm run check:ui       # Chromium + WebKit, 1x and 2x, ~3 min -- before committing
```

`check:ui` flies the real page and fails on measured framing, instrument
positions, panels overlapping at four window sizes, each camera's stand-off, a
render budget, the mouse and gamepad axes, and the whole
sign-in-and-fly-a-ranked-match flow. Every one of those was added after a fault
it would have caught shipped unnoticed. It creates a guest on the real project,
so the account flow runs at pixel ratio 1 and honours `UI_CHECK_SKIP_ACCOUNT=1`.

## Known gaps

- `energy-fighter` is a rule-based pilot, not a good one. It is the floor a
  model has to clear, and nothing here has been calibrated against a strong one.
  Nothing has cleared it yet either.
- Match counts are small. Eighteen matches separate 1-17 from 3-3 on the same
  pair of entrants, and the Elo ratings carry no confidence interval, so read
  the leaderboard as a record of what has been flown rather than a ranking.
- The Anthropic adapter has never been run against a live endpoint here. The
  OpenAI one has been driven far enough to prove the caller-key path reaches the
  provider and is rejected for a bad key. Jev has flown full matches.
- A browser-reported result cannot be verified by re-simulation. See above.
- Scoring beyond survival is simple: damage, gun time, control-zone time, and it
  has not been tuned against anybody's judgement of who actually won.
- No missiles, countermeasures, wingmen or loadout.
