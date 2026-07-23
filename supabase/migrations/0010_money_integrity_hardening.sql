-- Phase 1 hardening — money-path integrity (pre-kickoff security review).
-- Addresses review findings S2/S3/S4/S9 at the database layer, so the controls
-- hold even against a direct PostgREST call that bypasses the server actions.
--
-- IMPORTANT: apply this against the Phase 1 dev DB (NOT the shared POC DB), then
-- re-run scripts/verify-access-matrix.mjs before merging. Every rule below is
-- deliberately skipped for the service role (auth.uid() IS NULL) so seed
-- scripts and webhook/system writes are unaffected; the rules bind only real
-- authenticated users — which is exactly the S2 threat (staff doing a direct
-- PATCH to jump the gate).

-- ── S2/S9: payment state-machine enforced at the DB ─────────────────────────
-- The verify → validate → approve → remit sequence lived only in server
-- actions; RLS let any admin/FM/finance PATCH a payment straight to 'approved'.
-- This BEFORE UPDATE trigger enforces legal transitions + the gate conditions,
-- and restricts money transitions ('approved'/'remitted') to finance/admin.
create or replace function enforce_payment_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  caller_role user_role := current_user_role();
begin
  -- Trusted system/seed writes (service role) are exempt.
  if auth.uid() is null then
    return new;
  end if;

  -- No status change → allow (other column edits are governed by RLS).
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Legal transitions only.
  if not (
    (old.status = 'pending_verification' and new.status in ('verified','rejected'))
    or (old.status = 'verified'          and new.status in ('recommended','rejected'))
    or (old.status = 'recommended'       and new.status in ('approved','rejected'))
    or (old.status = 'approved'          and new.status = 'remitted')
  ) then
    raise exception 'illegal payment transition: % -> %', old.status, new.status;
  end if;

  -- Gate conditions for each forward step.
  if new.status = 'recommended' and (new.service_verified_at is null or new.performance_validated is not true) then
    raise exception 'cannot recommend: verification + performance gate not satisfied';
  end if;
  if new.status = 'approved' then
    if new.service_verified_at is null or new.performance_validated is not true then
      raise exception 'cannot approve: gate not satisfied';
    end if;
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance/admin may approve payments';
    end if;
  end if;
  if new.status = 'remitted' then
    if new.approved_at is null then
      raise exception 'cannot remit: payment not approved';
    end if;
    if caller_role not in ('finance_approver','admin') then
      raise exception 'only finance/admin may remit payments';
    end if;
  end if;

  return new;
end;
$$;

create trigger enforce_payment_transition_trg before update on payments
  for each row execute function enforce_payment_transition();

-- ── S3/S4: widen audit coverage ─────────────────────────────────────────────
-- 0005 only audited *status changes* on payments/tickets/sc_budgets + settings.
-- Money-relevant events were invisible: evaluation inserts (they drive the KPI
-- gate), payment/SC creation, and SC amount edits / deletes.

-- Vendor evaluations feed the payment performance gate → audit every insert.
create trigger audit_vendor_evaluation_insert after insert on vendor_evaluations
  for each row execute function log_audit('vendor_evaluation.created');

-- Payment creation (0005 only caught later status changes).
create trigger audit_payment_insert after insert on payments
  for each row execute function log_audit('payment.created');

-- Service charges: creation, amount/status edits, and (soft) deletion.
create trigger audit_service_charge_write after insert or update on service_charges
  for each row execute function log_audit('service_charge.write');

-- ── S4: soft-delete for service_charges (A3 "soft-delete only") ─────────────
alter table service_charges add column if not exists deleted_at timestamptz;

-- Block hard DELETE by authenticated users; they must set deleted_at instead.
-- Service role (seeds/truncate) is exempt. TRUNCATE bypasses row triggers.
create or replace function block_hard_delete()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null then
    raise exception '% is soft-delete only; set deleted_at instead', TG_TABLE_NAME;
  end if;
  return old;
end;
$$;

create trigger service_charges_no_hard_delete before delete on service_charges
  for each row execute function block_hard_delete();

-- Hide soft-deleted rows from reads. Rewrites the 0009 select policy, adding a
-- `deleted_at is null` guard while keeping the property-scoping clauses intact.
drop policy if exists service_charges_select on service_charges;
create policy service_charges_select on service_charges for select
  using (
    deleted_at is null
    and org_id = current_user_org_id()
    and (
      billed_to_user_id = auth.uid()
      or current_user_role() = any (array['admin','finance_approver']::user_role[])
      or budget_id in (
        select id from sc_budgets where property_id in (select current_user_property_ids())
      )
    )
  );
