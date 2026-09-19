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

## Two ways to fly the same aircraft

`tactical` names a manoeuvre, a load factor and a throttle; an autopilot flies
that order continuously until the next answer. `raw` moves the stick directly
and is held until the next answer, with nothing interpreting it and nothing
gating the trigger.

They are separate entrants with separate ratings, because folding them together
would average a model's grasp of tactics with its grasp of aerodynamics and
report one number meaning neither. The interface is named beside the model in
the viewer's **You** / **Opponent** control.

The stick interface is the harder one at a decision a second: holding a gun
solution means correcting continuously, and a control position chosen once a
second is frozen for the whole second.

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

Where that leaves it, on the live leaderboard over eighteen matches against
`energy-fighter`: **1-17**, with 14 hits from 93 rounds fired. The scripted
pilot manages 114 from 1,635. So Jev shoots about twice as well per round and
gets a shot roughly a twentieth as often -- it is not failing at gunnery, it is
failing to arrive at a gun solution, which is the part of a dogfight that is
actually hard. Before the two fixes above it fired almost nothing and had never
hit anything at all.

Read that as one model against one hand-tuned opponent, not as a ranking. A
six-match sample of the same pair came out 3-3, which is roughly what six
matches of anything are worth.

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

## Checks

```bash
npm test               # 147 tests, ~12 s
npm run build          # typecheck and bundle
npm run check:ui:fast  # one engine, ~40 s -- the loop while changing a layout
npm run check:ui       # Chromium + WebKit, 1x and 2x, ~3 min -- before committing
```

`check:ui` drives the *default* live state at widescreen size and fails on
measured framing, instrument positions, overlapping panels, the camera's own
stand-off in each view, a render budget, the mouse and gamepad axes, and the
whole sign-in-and-fly-a-ranked-match flow. Every
one of those was added after a fault it would have caught shipped without
anybody noticing. It creates a guest on the real project, so the account flow
runs at pixel ratio 1 only and honours `UI_CHECK_SKIP_ACCOUNT=1`.

`tools/browser-feedback/` is a separate agentic loop: Jev drives the real
controls and the harness verifies the resulting state. Its case names the
controls in words, so renaming one in the interface is a change to that file.

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
