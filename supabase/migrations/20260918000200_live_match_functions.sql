-- Counting a served decision. Best effort from the caller's point of view: it
-- must never fail the decision the player is waiting on.
create or replace function public.note_live_decision(p_id uuid, p_cost double precision)
returns void language sql security definer set search_path = public as $$
  update live_matches
     set decisions_served = decisions_served + 1,
         cost_usd = cost_usd + coalesce(p_cost, 0)
   where id = p_id and settled = false;
$$;

-- Claiming a live match, exactly once.
--
-- Read and mark in a single statement so two submissions racing each other
-- cannot both come back unsettled and both be recorded. The returned row is
-- the state as it was before settling, which is what the caller has to check
-- the reported result against.
create or replace function public.settle_live_match(p_id uuid)
returns table (
  id uuid,
  user_id uuid,
  opponent_kind text,
  decisions_served integer,
  cost_usd double precision,
  settled boolean,
  created_at timestamptz
) language sql security definer set search_path = public as $$
  update live_matches
     set settled = true
   where live_matches.id = p_id and live_matches.settled = false
  returning live_matches.id, live_matches.user_id, live_matches.opponent_kind,
            live_matches.decisions_served, live_matches.cost_usd, false, live_matches.created_at;
$$;

revoke all on function public.note_live_decision(uuid, double precision) from public, anon, authenticated;
revoke all on function public.settle_live_match(uuid) from public, anon, authenticated;
