-- The hourly escalation could not write a single row, and had not been able to
-- since 0212.
--
-- ⚠️ Found by `verify-unassigned-escalation.mjs`, which did not fail — it
-- CRASHED, with P0001 raised by `tickets_require_an_assignee()` from inside
-- `escalate_stale_unassigned_requests()`.
--
-- The two rules are individually correct and jointly impossible:
--
--   * 0117 refuses a ticket claiming `assigned` / `acknowledged` /
--     `in_progress` with neither a vendor nor an ops person on it — a job in
--     hand, in nobody's hand. It fires BEFORE INSERT OR UPDATE, deliberately,
--     so the state is refused rather than recorded and corrected after. It also
--     deliberately did NOT rewrite the rows already in that state, reasoning
--     that "the trigger fires on UPDATE, so each will refuse the next status
--     change until someone dispatches it properly".
--
--   * `escalate_stale_unassigned_requests` (0212) selects tickets with both
--     assignee columns null and `status not in ('resolved','closed')` — which
--     INCLUDES all three of those statuses — and its first act per ticket is
--     `update tickets set escalated_at = now()`.
--
-- So the job's own working set is exactly the set 0117 refuses, and the write
-- it is refused on is not a status change at all: it is a timestamp. 0117
-- anticipated the next STATUS change and got an unrelated one.
--
-- 📌 The damage is not one skipped ticket. The loop has no exception handler,
-- so the first legacy row aborts the WHOLE pass — every organisation, every
-- hour, since 0212. `stale_unassigned_requests()` reported 66 waiting requests
-- on dev while `escalated_at` was null on all of them: the rescue queue was
-- correct on screen and no administrator was ever told.
--
-- ── The fix, and the one that was rejected ────────────────────────────────
--
-- 0117's boundary is about ENTERING a meaningless state, not about freezing the
-- rows already in it. The guard now fires only when the write actually moves a
-- row into that state — on INSERT, or when the status or either assignee
-- column changes. No new row can reach it, which is everything 0117 was for,
-- and an unrelated column may be written on a row that is already there.
--
-- The alternative was to exclude those statuses from the job's own SELECT. It
-- fixes the crash and makes things worse: those rows ARE stale unassigned
-- requests — that is precisely what makes them wrong — so filtering them out
-- would leave the ones most in need of rescue as the only ones nobody is told
-- about, and would do it silently. The escalation is the mechanism that puts
-- them in front of a human; it must not be the thing that hides them.
--
-- Not done here, and worth saying why: the loop still has no per-ticket
-- exception handler. Wrapping it would mean a future refusal is swallowed and
-- the job reports success while skipping rows — trading a loud total failure
-- for a quiet partial one. 0212 already reasoned that a crash costs one
-- notification and nothing else, because the request stays on the rescue queue
-- either way. That reasoning holds; what did not hold was a crash on EVERY run.

create or replace function tickets_require_an_assignee()
returns trigger language plpgsql set search_path = public as $$
declare
  -- 0298. Does this write MOVE the row into the state, as opposed to finding it
  -- already there? That is the whole of the change.
  --
  -- ⚠️ Computed in its own branch rather than as one `tg_op = 'INSERT' or
  -- old.… ` chain. OLD is unassigned in an INSERT trigger, and PL/pgSQL
  -- evaluates the condition as a single SQL expression with no guaranteed
  -- short-circuit — so the `tg_op` test on the left would not reliably stop
  -- `old.status` on the right from being reached.
  --
  -- `is distinct from`, not `<>`: all three columns are nullable and
  -- `null <> null` is null, so `<>` would read a dispatch that CLEARED an
  -- assignee as "unchanged" and wave it straight past the guard — reopening
  -- the exact hole 0117 closed.
  v_entering boolean;
begin
  if tg_op = 'INSERT' then
    v_entering := true;
  else
    v_entering := old.status              is distinct from new.status
               or old.assigned_vendor_id  is distinct from new.assigned_vendor_id
               or old.assigned_to_user_id is distinct from new.assigned_to_user_id;
  end if;

  if v_entering
     and new.status in ('assigned', 'acknowledged', 'in_progress')
     and new.assigned_vendor_id is null
     and new.assigned_to_user_id is null then
    raise exception
      'a request cannot be % with nobody assigned — dispatch it to a vendor or ops person first',
      new.status;
  end if;
  return new;
end;
$$;

comment on function tickets_require_an_assignee is
  'Refuses a write that moves a ticket INTO assigned/acknowledged/in_progress with neither a vendor nor an ops person on it. That state is what made a dispatched job invisible to its vendor: every downstream surface keys off assigned_vendor_id, so a status moved without one is a job nobody holds. Narrowed by 0298 to the transition rather than the row: rows already in that state (0117 deliberately left them) may still be written to on other columns, because the hourly escalation stamps escalated_at on exactly those rows and was aborting the entire pass on the first one.';

-- ── What this leaves ──────────────────────────────────────────────────────
--
-- The trigger's SHAPE is asserted here. Its BEHAVIOUR is proved by
-- `verify-unassigned-escalation.mjs`, which is what found this and is the thing
-- to run after applying — a migration that stamps `escalated_at` on live rows
-- to prove itself would notify real administrators as a side effect of being
-- applied, which is not a migration's business.
do $$
declare
  v_def text;
  v_legacy int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tickets_require_an_assignee';

  if v_def !~* 'tg_op' then
    raise exception '0298: the guard still fires on every write, not just the transition';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'tickets_require_assignee' and not tgisinternal
  ) then
    raise exception '0298: the tickets_require_assignee trigger is missing';
  end if;

  -- Reported, never rewritten. Guessing who these belong to would put a name
  -- against work that person may never have been told about (0117's reasoning,
  -- unchanged). They are now reachable by the escalation, which is how a human
  -- gets told about them.
  select count(*) into v_legacy
    from tickets
   where status in ('assigned', 'acknowledged', 'in_progress')
     and assigned_vendor_id is null
     and assigned_to_user_id is null;

  raise notice '0298: % ticket(s) sit in the state 0117 left standing; the hourly escalation can now stamp them', v_legacy;
end;
$$;
