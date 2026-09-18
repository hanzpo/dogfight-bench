-- Recording a match is one transaction, not five round trips.
--
-- Elo is a read-modify-write on both competitors' ratings, so doing it from the
-- application means two concurrent matches can read the same rating and write
-- back conflicting answers. Inside a function with the rows locked, the second
-- match sees the first one's result, which is the only way a rating that many
-- people are contributing to stays meaningful.
--
-- K is fixed at 24. Provisional competitors (unattached guests) still move
-- their opponent's rating: refusing to would mean a model could farm wins off
-- guests for free.
create or replace function public.record_match(
  p_match      jsonb,
  p_competitors jsonb,
  p_participants jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  competitor     jsonb;
  participant    jsonb;
  first_id       text;
  second_id      text;
  first_result   text;
  rating_first   double precision;
  rating_second  double precision;
  expected_first double precision;
  score_first    double precision;
  k              constant double precision := 24;
begin
  for competitor in select * from jsonb_array_elements(p_competitors) loop
    insert into competitors (id, kind, display_name, provider, model, policy_version, schema, user_id, provisional)
    values (
      competitor ->> 'id',
      competitor ->> 'kind',
      competitor ->> 'displayName',
      competitor ->> 'provider',
      competitor ->> 'model',
      coalesce(competitor ->> 'policyVersion', '1'),
      coalesce(competitor ->> 'schema', 'tactical'),
      nullif(competitor ->> 'userId', '')::uuid,
      coalesce((competitor ->> 'provisional')::boolean, false)
    )
    on conflict (id) do update
      set display_name = excluded.display_name,
          provisional  = excluded.provisional;
  end loop;

  insert into matches (id, scenario_id, seed, duration_s, winner, reason, origin, verified, summary, replay_path, submitted_by)
  values (
    (p_match ->> 'id')::uuid,
    p_match ->> 'scenarioId',
    (p_match ->> 'seed')::bigint,
    (p_match ->> 'durationS')::double precision,
    nullif(p_match ->> 'winner', ''),
    nullif(p_match ->> 'reason', ''),
    p_match ->> 'origin',
    coalesce((p_match ->> 'verified')::boolean, false),
    p_match -> 'summary',
    nullif(p_match ->> 'replayPath', ''),
    nullif(p_match ->> 'submittedBy', '')::uuid
  )
  on conflict (id) do nothing;

  -- Nothing below should run twice for the same match, or a retried submission
  -- would move ratings again.
  if not found then
    return;
  end if;

  for participant in select * from jsonb_array_elements(p_participants) loop
    insert into participants (
      match_id, aircraft_id, competitor_id, team, result, survived, health,
      hits_scored, hits_taken, rounds_fired, time_on_target_s, time_in_zone_s,
      decisions, failures, timeouts, avg_latency_ms, cost_usd
    ) values (
      (p_match ->> 'id')::uuid,
      participant ->> 'aircraftId',
      participant ->> 'competitorId',
      participant ->> 'team',
      participant ->> 'result',
      (participant ->> 'survived')::boolean,
      (participant ->> 'health')::double precision,
      (participant ->> 'hitsScored')::integer,
      (participant ->> 'hitsTaken')::integer,
      (participant ->> 'roundsFired')::integer,
      (participant ->> 'timeOnTargetS')::double precision,
      (participant ->> 'timeInZoneS')::double precision,
      (participant ->> 'decisions')::integer,
      (participant ->> 'failures')::integer,
      (participant ->> 'timeouts')::integer,
      (participant ->> 'avgLatencyMs')::double precision,
      (participant ->> 'costUsd')::double precision
    )
    on conflict (match_id, aircraft_id) do nothing;
  end loop;

  -- The alias must not be `participant`: that is also the loop variable above,
  -- and plpgsql refuses to guess which one a bare reference means.
  select entry ->> 'competitorId', entry ->> 'result'
    into first_id, first_result
    from jsonb_array_elements(p_participants) as entry
   limit 1;

  select entry ->> 'competitorId'
    into second_id
    from jsonb_array_elements(p_participants) as entry
   where entry ->> 'competitorId' is distinct from first_id
   limit 1;

  if first_id is null or second_id is null then
    return;
  end if;

  -- Lock both rows, in id order, so two matches involving the same pair queue
  -- up instead of deadlocking against each other. The ratings are read only
  -- after the locks are held, or the arithmetic would be done on stale values.
  perform 1 from competitors where id in (first_id, second_id) order by id for update;
  select rating into rating_first from competitors where id = first_id;
  select rating into rating_second from competitors where id = second_id;

  expected_first := 1.0 / (1.0 + power(10.0, (rating_second - rating_first) / 400.0));
  score_first := case first_result when 'win' then 1.0 when 'loss' then 0.0 else 0.5 end;

  update competitors set rating = rating_first + k * (score_first - expected_first) where id = first_id;
  update competitors set rating = rating_second + k * ((1.0 - score_first) - (1.0 - expected_first)) where id = second_id;

  update participants
     set rating_before = rating_first, rating_after = rating_first + k * (score_first - expected_first)
   where match_id = (p_match ->> 'id')::uuid and competitor_id = first_id;
  update participants
     set rating_before = rating_second, rating_after = rating_second + k * ((1.0 - score_first) - (1.0 - expected_first))
   where match_id = (p_match ->> 'id')::uuid and competitor_id = second_id;
end;
$$;

revoke all on function public.record_match(jsonb, jsonb, jsonb) from public, anon, authenticated;

-- Today's free-tier spend, incremented atomically.
create or replace function public.note_public_usage(p_provider text, p_cost double precision)
returns void language sql security definer set search_path = public as $$
  insert into public_usage (day, provider, decisions, cost_usd)
  values (current_date, p_provider, 1, coalesce(p_cost, 0))
  on conflict (day, provider) do update
    set decisions = public_usage.decisions + 1,
        cost_usd  = public_usage.cost_usd + excluded.cost_usd;
$$;

revoke all on function public.note_public_usage(text, double precision) from public, anon, authenticated;
