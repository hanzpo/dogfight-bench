-- Which interface a competitor flies through.
--
-- The same model at two interfaces is two pilots: `tactical` names a manoeuvre
-- and an autopilot flies it continuously; `raw` moves the stick directly and
-- nothing interprets it or keeps flying it. They already rank separately,
-- because the policy version differs, but without this the board shows two rows
-- with no way to tell which is which.
alter table public.competitors
  add column if not exists schema text not null default 'tactical'
  check (schema in ('raw', 'tactical'));
