-- Housekeeping, so the project does not fill up with things nobody wants.
--
-- Three kinds of litter accumulate on their own:
--
--   Guest sessions. Anyone can play without an account, and every one of them
--   creates an anonymous user. Most never come back and never record anything.
--
--   Live match tickets that were never settled. A ticket is issued when a match
--   starts and closed when the result is reported; a closed tab reports
--   nothing, so the row stays open forever.
--
--   Replays whose match has gone. Object storage does not cascade.
--
-- None of this runs by itself. Schedule it, or run it by hand; the point is
-- that it exists and says what it deletes rather than being a surprise later.

create or replace function public.prune_abandoned(p_older_than interval default interval '7 days')
returns table (guests_removed integer, tickets_removed integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  guests  integer;
  tickets integer;
begin
  -- Tickets first: an unsettled ticket is a match that was started and never
  -- finished, which is the ordinary result of closing a tab mid-fight.
  delete from live_matches
   where settled = false and created_at < now() - p_older_than;
  get diagnostics tickets = row_count;

  -- Then guests who left nothing behind. A guest who actually flew a ranked
  -- match owns a competitor row and is kept, because deleting them would strip
  -- the name off a result their opponent's rating already reflects.
  delete from auth.users u
   where u.is_anonymous
     and u.created_at < now() - p_older_than
     and not exists (select 1 from competitors c where c.user_id = u.id)
     and not exists (select 1 from matches m where m.submitted_by = u.id);
  get diagnostics guests = row_count;

  return query select guests, tickets;
end;
$$;

revoke all on function public.prune_abandoned(interval) from public, anon, authenticated;

-- Replays belonging to matches that no longer exist.
create or replace function public.orphaned_replays()
returns table (path text)
language sql
security definer
set search_path = public
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'replays'
     and not exists (select 1 from matches m where m.replay_path = o.name);
$$;

revoke all on function public.orphaned_replays() from public, anon, authenticated;
