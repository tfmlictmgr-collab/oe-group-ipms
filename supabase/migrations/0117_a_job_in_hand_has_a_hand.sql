-- A request cannot be "assigned" to nobody.
--
-- Reported: a job dispatched to a vendor did not appear in that vendor's
-- portal, and no notification arrived. Investigation found the ticket carrying
-- `status = 'assigned'` with `assigned_vendor_id` AND `assigned_to_user_id`
-- both null, and `assigned_at` null too — which `assign_ticket` always sets.
-- So the dispatch never ran. The status had been moved by the separate Status
-- dropdown, which happily accepts 'assigned' without an assignee.
--
-- 📌 The read path was never the problem, and it is worth recording so nobody
-- re-investigates it: impersonating the vendor through RLS, they see the
-- ticket correctly the instant `assigned_vendor_id` is actually set. Every
-- symptom — invisible in their portal, no notification, nothing on the job
-- card — came from the one field never being written.
--
-- Two states were therefore reachable and meaningless:
--   * 'assigned' with nobody assigned — a job in hand, in nobody's hand.
--   * the same for 'acknowledged' and 'in_progress', which are downstream of
--     it and inherit the hole.
-- Found live in two more tickets on another organisation, so this is not a
-- one-off mis-click; it is a state the system permits.
--
-- The UI is corrected alongside this (the manual status list no longer offers
-- 'assigned' — dispatching is what assigns, and a status dropdown that can
-- silently un-assign a job is a trap). But the UI is a courtesy; this is the
-- boundary.
create or replace function tickets_require_an_assignee()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('assigned', 'acknowledged', 'in_progress')
     and new.assigned_vendor_id is null
     and new.assigned_to_user_id is null then
    raise exception
      'a request cannot be % with nobody assigned — dispatch it to a vendor or ops person first',
      new.status;
  end if;
  return new;
end;
$$;

-- BEFORE, so the write is refused rather than recorded and corrected after.
-- Separate from `tickets_stamp_lifecycle` (0099) on purpose: that one stamps
-- timestamps and must not gain a reason to reject a write, and this one must
-- not gain a reason to silently rewrite a row. Two triggers, two jobs — the
-- same reasoning 0104's review-prompt trigger already follows.
drop trigger if exists tickets_require_assignee on tickets;
create trigger tickets_require_assignee
  before insert or update on tickets
  for each row execute function tickets_require_an_assignee();

comment on function tickets_require_an_assignee is
  'Refuses a ticket claiming assigned/acknowledged/in_progress with neither a vendor nor an ops person on it. That state is what made a dispatched job invisible to its vendor: every downstream surface (their portal, the notification, the job card) keys off assigned_vendor_id, so a status moved without one is a job nobody holds.';

-- ⚠️ Existing rows are NOT rewritten. Three tickets are in this state today
-- (one on TFML, two on the POC). Guessing who they belong to would put a name
-- against work that person may never have been told about — worse than an
-- honest gap. The trigger fires on UPDATE, so each will refuse the next status
-- change until someone dispatches it properly, which surfaces them to a human
-- exactly when a human is already looking. `scripts/verify-role-workflows.mjs`
-- reports the count so they can be found deliberately rather than stumbled on.
