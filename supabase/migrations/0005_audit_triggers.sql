-- Audit & Compliance (Module 5, Day 11).
-- DB-level audit so entries are captured no matter the code path, and the
-- audit_log is made truly append-only (immutable) at the database.

-- ── Generic audit writer ───────────────────────────────────────────────────
-- SECURITY DEFINER so it can insert into audit_log despite the no-insert RLS.
-- auth.uid() still reflects the calling request's JWT (null for service-role /
-- system writes, e.g. webhook-created rows).
create or replace function log_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j_new jsonb := case when TG_OP <> 'DELETE' then to_jsonb(new) else null end;
  j_old jsonb := case when TG_OP <> 'INSERT' then to_jsonb(old) else null end;
  v_org uuid := coalesce((j_new->>'org_id')::uuid, (j_old->>'org_id')::uuid);
  v_entity uuid := coalesce((j_new->>'id')::uuid, (j_old->>'id')::uuid, v_org);
begin
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (v_org, auth.uid(), TG_ARGV[0], TG_TABLE_NAME, v_entity, j_old, j_new);
  return coalesce(new, old);
end;
$$;

-- ── Auditable events ───────────────────────────────────────────────────────
create trigger audit_payments after update on payments
  for each row when (old.status is distinct from new.status)
  execute function log_audit('payment.status_change');

create trigger audit_tickets after update on tickets
  for each row when (old.status is distinct from new.status)
  execute function log_audit('ticket.status_change');

create trigger audit_budgets after update on sc_budgets
  for each row when (old.status is distinct from new.status)
  execute function log_audit('sc_budget.status_change');

create trigger audit_settings after insert or update on payment_settings
  for each row execute function log_audit('payment_settings.update');

-- ── Immutability: audit_log is append-only ─────────────────────────────────
create or replace function prevent_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only; % is not permitted', TG_OP;
end;
$$;

create trigger audit_no_update before update on audit_log
  for each row execute function prevent_audit_mutation();
create trigger audit_no_delete before delete on audit_log
  for each row execute function prevent_audit_mutation();
