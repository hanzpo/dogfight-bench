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
| `src/ui/` | Viewer, flight display, leaderboard, matches, replay |
| `server/` | Provider adapters, match runner, accounts, HTTP API |
| `worker/`, `wrangler.toml` | The same API on Cloudflare |
| `supabase/migrations/` | Results schema, Elo, housekeeping |
| `tools/ui-check/` | Browser check (Chromium + WebKit, 1x and 2x) |

## Two ways to fly the same aircraft

`tactical` names a manoeuvre, a load factor and a throttle detent; an autopilot
flies that order continuously until the next answer. `raw` moves the stick
directly and is held until the next answer, with nothing interpreting it and
nothing gating the trigger.

They are separate entrants with separate ratings, because folding them together
would average a model's grasp of tactics with its grasp of aerodynamics and
report one number meaning neither. Jev is offered as both: pick `jev` or
`jev-stick` in the viewer's **You** / **Opponent** control, where the interface
is named beside the model, or `--blue jev-stick` on the command line.

The stick interface is the harder one at a decision a second: holding a gun
solution means correcting continuously, and a control position chosen once a
second is frozen for the whole second.

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
npm test               # 142 tests, ~8 s
npm run build          # typecheck and bundle
npm run check:ui:fast  # one engine, ~40 s -- the loop while changing a layout
npm run check:ui       # Chromium + WebKit, 1x and 2x, ~3 min -- before committing
```

`check:ui` drives the *default* live state at widescreen size and fails on
measured framing, instrument positions, overlapping panels, a render budget, the
mouse and gamepad axes, and the whole sign-in-and-fly-a-ranked-match flow. Every
one of those was added after a fault it would have caught shipped without
anybody noticing. It creates a guest on the real project, so the account flow
runs at pixel ratio 1 only and honours `UI_CHECK_SKIP_ACCOUNT=1`.

`tools/browser-feedback/` is a separate agentic loop: Jev drives the real
controls and the harness verifies the resulting state. Its case names the
controls in words, so renaming one in the interface is a change to that file.

## Known gaps

- `energy-fighter` is a rule-based pilot, not a good one. It is the floor a
  model has to clear, and nothing here has been calibrated against a strong one.
- The Anthropic adapter has never been run against a live endpoint here. The
  OpenAI one has been driven far enough to prove the caller-key path reaches the
  provider and is rejected for a bad key. Jev has flown full matches.
- A browser-reported result cannot be verified by re-simulation. See above.
- Scoring beyond survival is simple: damage, gun time, control-zone time, and it
  has not been tuned against anybody's judgement of who actually won.
- No missiles, countermeasures, wingmen or loadout.
