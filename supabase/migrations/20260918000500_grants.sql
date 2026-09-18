-- Privileges, which row level security does not replace.
--
-- The tables were created without any DML grants to the API roles, so every
-- request through PostgREST failed with "permission denied" -- including the
-- public leaderboard read, whose select policy was decorative because `anon`
-- had no SELECT privilege for the policy to qualify.
--
-- The two are different mechanisms and both are required: a grant says the role
-- may touch the table at all, and a policy says which rows. `service_role`
-- bypasses policies but still needs the grant.

grant select on public.competitors, public.matches, public.participants to anon, authenticated;

grant select, insert, update, delete
  on public.competitors, public.matches, public.participants, public.public_usage, public.live_matches
  to service_role;

-- `public_usage` and `live_matches` are deliberately absent from the anon and
-- authenticated grants: a browser has no business reading either.

-- The functions run as their definer, so the roles that call them need execute.
grant execute on function public.record_match(jsonb, jsonb, jsonb) to service_role;
grant execute on function public.note_public_usage(text, double precision) to service_role;
grant execute on function public.note_live_decision(uuid, double precision) to service_role;
grant execute on function public.settle_live_match(uuid) to service_role;
grant execute on function public.prune_abandoned(interval) to service_role;
grant execute on function public.orphaned_replays() to service_role;
