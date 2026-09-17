-- When a request was actually finished.
--
-- ⚠️ Day 10 asks for "average time-to-resolve" and "which vendor completes
-- fastest", and neither is computable: `tickets` records a status but never the
-- moment it changed. A ticket has been `resolved` since some unknown point, and
-- `created_at` minus nothing is not a duration.
--
-- This is the second time this build has wanted a fact nobody wrote down. The
-- fix is the same shape as `payments`: stamp the transition where it happens, in
-- a trigger, so it cannot be forgotten by a caller who updates the status
-- directly.

alter table tickets add column if not exists resolved_at timestamptz;
alter table tickets add column if not exists first_response_at timestamptz;

comment on column tickets.resolved_at is
  'When the ticket first reached resolved/closed. Set by trigger, never by a caller — a duration derived from a field someone might forget to set is worse than no duration at all.';
comment on column tickets.first_response_at is
  'When someone first acknowledged or worked the ticket, for response-time reporting as distinct from completion time.';

-- ── Stamped where the transition happens ──────────────────────────────────
create or replace function tickets_stamp_lifecycle()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Set ONCE, on the first arrival at a terminal state. A ticket reopened and
  -- resolved again keeps its original resolution time rather than reporting the
  -- second one as if the first never happened — reopening is a fact the report
  -- should show as a reopen, not as a faster fix.
  if new.status in ('resolved', 'closed')
     and old.status not in ('resolved', 'closed')
     and new.resolved_at is null then
    new.resolved_at := now();
  end if;

  -- Leaving a terminal state does NOT clear resolved_at, for the same reason.
  if new.status in ('open', 'in_progress')
     and old.status in ('resolved', 'closed') then
    new.first_response_at := coalesce(new.first_response_at, old.first_response_at);
  end if;

  -- First time anyone moves it off `open`, or acknowledges it.
  if new.first_response_at is null
     and (new.status <> 'open' or new.acknowledged_at is not null) then
    new.first_response_at := coalesce(new.acknowledged_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists tickets_lifecycle on tickets;
create trigger tickets_lifecycle before update on tickets
  for each row execute function tickets_stamp_lifecycle();

comment on function tickets_stamp_lifecycle is
  'Stamps resolution and first-response times as the status moves. Set once: a reopened ticket keeps its original resolution time, because a reopen is a fact a report should show rather than a faster fix.';

-- ⚠️ NOT backfilled.
--
-- Every ticket already sitting at `resolved` has no honest resolution time —
-- the moment was never recorded and cannot be recovered. Writing `created_at`,
-- or `now()`, or any interpolation would manufacture durations that look real,
-- get averaged, and end up in a board report as fact.
--
-- They stay NULL and every aggregate below excludes them explicitly, so
-- "average time-to-resolve" means "of the tickets we actually timed" rather than
-- "of all tickets, some of which we invented".
