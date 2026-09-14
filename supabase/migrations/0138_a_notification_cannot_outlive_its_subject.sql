-- A notification whose subject is gone still says "click here."
--
-- Reported: an admin and a finance approver both hit a 404 clicking a
-- notification. Traced by extracting the id from every admin/finance
-- notification's own `link` and checking existence directly (service role,
-- bypassing RLS entirely, so this was never a visibility question) — 15 of 21
-- id-bearing links pointed at a `tickets` or `payments` row that no longer
-- exists. Every one of them was "A contractor declined a job" / "...marked a
-- job complete" / "...submitted an invoice" (0118's three notify_role calls),
-- landing on `tfml.admin@oegroup.test` and `tfml.financeapprover@oegroup.test`
-- — consistent with repeated live testing against those functions followed by
-- test-row cleanup that deleted the ticket/payment but never touched the
-- notification pointing at it.
--
-- ⚠️ The lesson, so this class of bug does not recur: `user_notifications`
-- is deliberately polymorphic (`entity_type` + `entity_id`, spanning several
-- tables) precisely so ONE notification centre can cover tickets, payments,
-- applications and more without a table per kind — but a polymorphic
-- reference cannot be a foreign key, so it was never enforced, and nothing
-- ever told a notification its subject was deleted. That gap doesn't only
-- matter for test-data churn: `tickets` and `payments` are not supposed to be
-- hard-deleted in production (GO_LIVE_CHECKLIST — financial rows are
-- retained, not deletable), but a probe/test org's rows legitimately are, and
-- this system will keep having a demo/dev environment doing exactly that
-- long after this specific batch is cleaned up. The fix has to be structural,
-- not a one-time delete.

-- ── 1. Clean up what already broke ─────────────────────────────────────────
-- Deletes only rows whose `entity_id` (extracted from the id-shaped tail of
-- `link`) no longer exists in the table `entity_type` says it belongs to.
-- Static links (`/dashboard`, `/dashboard/people`, …) have no id to check and
-- are left untouched, as is every notification whose subject is still there.
do $$
declare
  v_deleted integer := 0;
begin
  delete from user_notifications n
   where n.entity_type = 'ticket'
     and n.entity_id is not null
     and not exists (select 1 from tickets t where t.id = n.entity_id);
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned ticket notification(s)', v_deleted;

  delete from user_notifications n
   where n.entity_type = 'payment'
     and n.entity_id is not null
     and not exists (select 1 from payments p where p.id = n.entity_id);
  get diagnostics v_deleted = row_count;
  raise notice 'removed % orphaned payment notification(s)', v_deleted;
end $$;

-- ── 2. Stop it recurring: a deleted subject takes its notifications with it ─
--
-- One function, parameterised by which table and entity_type it is watching,
-- rather than one copy per table — the same reasoning `handle-inbound.ts`
-- gives for not duplicating the WhatsApp/Telegram routing logic.
create or replace function delete_notifications_for_deleted_entity()
returns trigger language plpgsql set search_path = public as $$
begin
  delete from user_notifications
   where entity_type = TG_ARGV[0]
     and entity_id = old.id;
  return old;
end;
$$;

comment on function delete_notifications_for_deleted_entity is
  'AFTER DELETE trigger: removes any user_notifications row pointing at the row just deleted. entity_id is polymorphic and cannot be a real foreign key, so this is what keeps a notification from outliving its subject and 404ing whoever clicks it (0138).';

drop trigger if exists tickets_delete_cleans_notifications on tickets;
create trigger tickets_delete_cleans_notifications
  after delete on tickets
  for each row execute function delete_notifications_for_deleted_entity('ticket');

drop trigger if exists payments_delete_cleans_notifications on payments;
create trigger payments_delete_cleans_notifications
  after delete on payments
  for each row execute function delete_notifications_for_deleted_entity('payment');
