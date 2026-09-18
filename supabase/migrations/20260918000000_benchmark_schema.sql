-- Dogfight Bench results schema.
--
-- A competitor is anything that can hold a rating: a model, a scripted
-- baseline, or a person. Keeping them in one table is what lets a human beat a
-- model and have the model's rating actually move, which is the whole point of
-- a crowdsourced leaderboard -- two people beating the same model must cost it
-- twice, and that only works if the model is one row rather than one row per
-- opponent.
--
-- A model's identity is provider + model + policy version. The policy version
-- is part of it deliberately: changing the prompt changes the player, and
-- silently folding the new one's results into the old one's rating would make
-- the number meaningless.

create table if not exists public.competitors (
  id             text primary key,
  kind           text not null check (kind in ('human', 'model', 'scripted')),
  display_name   text not null,
  provider       text not null,
  model          text not null,
  policy_version text not null default '1',
  -- Humans only; null for models and baselines.
  user_id        uuid references auth.users (id) on delete set null,
  rating         double precision not null default 1500,
  -- Guests are ranked but not listed, so an unattached identity cannot farm
  -- the board by signing in again.
  provisional    boolean not null default false,
  created_at     timestamptz not null default now()
);

create unique index if not exists competitors_user on public.competitors (user_id)
  where user_id is not null;

create table if not exists public.matches (
  id           uuid primary key,
  scenario_id  text not null,
  seed         bigint not null,
  created_at   timestamptz not null default now(),
  duration_s   double precision not null,
  winner       text references public.competitors (id),
  reason       text,
  -- 'headless' matches were run by this server and are reproducible from their
  -- decision log. 'live' matches were flown in a browser and are not: a live
  -- decision is applied whenever the network returns it, so the same log does
  -- not replay tick for tick. The distinction is recorded rather than hidden.
  origin       text not null check (origin in ('headless', 'live')),
  -- True when the server itself served every decision in the match, so the
  -- result could not have been invented by the client that reported it.
  verified     boolean not null default false,
  summary      jsonb not null,
  replay_path  text,
  submitted_by uuid references auth.users (id) on delete set null
);

create index if not exists matches_created on public.matches (created_at desc);

create table if not exists public.participants (
  match_id         uuid not null references public.matches (id) on delete cascade,
  aircraft_id      text not null,
  competitor_id    text not null references public.competitors (id),
  team             text not null,
  result           text not null check (result in ('win', 'loss', 'draw')),
  survived         boolean not null,
  health           double precision not null,
  hits_scored      integer not null default 0,
  hits_taken       integer not null default 0,
  rounds_fired     integer not null default 0,
  time_on_target_s double precision not null default 0,
  time_in_zone_s   double precision not null default 0,
  decisions        integer not null default 0,
  failures         integer not null default 0,
  timeouts         integer not null default 0,
  avg_latency_ms   double precision not null default 0,
  cost_usd         double precision not null default 0,
  rating_before    double precision,
  rating_after     double precision,
  primary key (match_id, aircraft_id)
);

create index if not exists participants_competitor on public.participants (competitor_id);

-- What the free providers have spent today, across everybody. In the database
-- rather than in memory because a restart must not hand out a fresh budget.
create table if not exists public.public_usage (
  day       date not null,
  provider  text not null,
  decisions integer not null default 0,
  cost_usd  double precision not null default 0,
  primary key (day, provider)
);

-- A ticket issued when someone starts a live match, and closed when they
-- report the result.
--
-- This is what makes a browser-reported result worth recording. The server
-- counts the decisions it actually served for this match, so a client cannot
-- claim to have beaten a model it never called. It does not stop someone
-- flying a real match and lying about who won, which is why the replay is kept
-- and the row says plainly whether the result was verified.
create table if not exists public.live_matches (
  id               uuid primary key,
  created_at       timestamptz not null default now(),
  user_id          uuid references auth.users (id) on delete cascade,
  opponent_kind    text not null,
  decisions_served integer not null default 0,
  cost_usd         double precision not null default 0,
  settled          boolean not null default false
);

create index if not exists live_matches_open on public.live_matches (created_at)
  where settled = false;

-- Results are public to read and written only by the server, which holds the
-- service role key and bypasses these policies. Nothing here is writable by a
-- browser: a leaderboard anyone can INSERT into is not a leaderboard.
alter table public.competitors   enable row level security;
alter table public.matches       enable row level security;
alter table public.participants  enable row level security;
alter table public.public_usage  enable row level security;
alter table public.live_matches  enable row level security;

drop policy if exists competitors_read on public.competitors;
create policy competitors_read on public.competitors for select using (true);

drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (true);

drop policy if exists participants_read on public.participants;
create policy participants_read on public.participants for select using (true);

-- public_usage and live_matches have row level security on and no policy at
-- all, so they are server-only by construction.
