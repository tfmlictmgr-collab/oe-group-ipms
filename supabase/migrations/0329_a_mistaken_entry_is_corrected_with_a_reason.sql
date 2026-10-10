-- A mistaken entry on a tenancy, a rent demand or a service-charge budget is
-- corrected, with a reason, by the desk that made it (requested 9 Oct 2026:
-- "roles that perform lease/rent scheduling should have the option to
-- correct/edit details filled for tenant rent/service charges in the event of
-- a mistake in entry").
--
-- Measured first:
--   • A tenancy's rent, term and deposit had no edit screen at all. Yet
--     `authenticated` holds UPDATE on every column of `leases` and
--     `leases_write` admits the letting desk, so a direct API call could
--     rewrite the rent of a LIVE tenancy with no reason and nothing refusing.
--   • A rent demand could not be corrected by anybody: `rent_charges` has no
--     client write policy, so a mistyped figure stood until it was paid.
--   • An invoiced service-charge budget's total and method were writable by a
--     direct call (the 0315 guard fixes the property and the void, nothing
--     else), so a budget could silently stop matching the invoices raised
--     from it.
--
-- What is corrected, and where it stops:
--   • TENANCY TERMS (rent, frequency, deposit, escalation, dates) through
--     `correct_lease_terms`. A draft is edited freely; a live tenancy needs a
--     reason, which goes on the audit trail. A live tenancy never moves to
--     another unit or tenant — that is ending one and recording another.
--     Demands already raised keep their own figures (decision 14's snapshot):
--     a demand that was wrong is corrected on its own, below.
--   • A RENT DEMAND through `correct_rent_charge`, only while nothing has
--     happened to it: unpaid, no payment request open or paid, no off-platform
--     payment naming it, not posted, not remitted. The management fee is
--     recomputed at the rate already frozen on the demand, never today's.
--   • A SERVICE-CHARGE BUDGET through `reopen_sc_budget_for_correction` —
--     decided with the requester as "fix the inputs, re-issue": the budget's
--     invoices are withdrawn (soft-deleted, the only kind this table allows),
--     its total or description corrected, and it goes back to draft, where the
--     method and shares can be fixed and the invoices generated again. Refused
--     on exactly `void_sc_budget`'s money test. Editing one tenant's invoice on
--     its own was offered and declined: it breaks the invoices summing to the
--     budget, which is the invariant apportionment exists to keep (0227).
--
-- Each is SECURITY DEFINER because each writes the audit trail and the
-- demand table, neither of which a client may write. Each restates its
-- table's own write rule (permission plus place) the way `void_sc_budget`
-- already does, and refuses an Owner Rep in so many words. The direct-write
-- holes are closed by triggers that let only these functions through.

set local lock_timeout = '5s';

-- ── 1. Tenancy terms ───────────────────────────────────────────────────────
create or replace function guard_live_lease_terms()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The service role and system jobs (no signed-in caller) are not this
  -- guard's subject; every function they call states its own rules.
  if auth.uid() is null or old.status = 'draft' then
    return new;
  end if;

  if new.unit_id is distinct from old.unit_id
     or new.property_id is distinct from old.property_id
     or new.tenant_user_id is distinct from old.tenant_user_id then
    raise exception 'A live tenancy cannot be moved to another unit or another tenant. End it and record a new one.';
  end if;

  if (new.rent_amount, new.rent_frequency, new.deposit_amount, new.escalation_pct,
      new.currency, new.start_date, new.end_date, new.paid_in_advance, new.admin_fee_basis)
     is distinct from
     (old.rent_amount, old.rent_frequency, old.deposit_amount, old.escalation_pct,
      old.currency, old.start_date, old.end_date, old.paid_in_advance, old.admin_fee_basis)
     and coalesce(current_setting('app.lease_correction', true), '') <> old.id::text then
    raise exception 'A live tenancy''s terms are corrected with Correct tenancy details, which records why.';
  end if;

  return new;
end $$;

revoke all on function guard_live_lease_terms() from public, anon, authenticated, service_role;

drop trigger if exists leases_guard_live_terms on leases;
create trigger leases_guard_live_terms
  before update on leases
  for each row execute function guard_live_lease_terms();

create or replace function correct_lease_terms(
  p_lease_id uuid,
  p_rent_amount numeric,
  p_rent_frequency text,
  p_deposit_amount numeric,
  p_escalation_pct numeric,
  p_start_date date,
  p_end_date date,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := active_uid();
  l leases%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_after leases%rowtype;
begin
  if v_me is null then
    raise exception 'Sign in to do this.';
  end if;

  select * into l from leases where id = p_lease_id and deleted_at is null for update;
  if l.id is null or l.org_id is distinct from current_user_org_id() then
    raise exception 'That tenancy could not be found.';
  end if;

  -- `leases_write`, restated because DEFINER bypasses it.
  if caller_is_owner_rep()
     or not coalesce(has_permission('leases.write'), false)
     or not (current_user_role() = any (oversight_roles())
             or l.property_id in (select current_user_property_ids())) then
    raise exception 'You do not have permission to correct this tenancy.';
  end if;

  if l.status not in ('draft', 'active', 'renewed') then
    raise exception 'This tenancy has ended (%), so its terms are a record and cannot be changed.', l.status;
  end if;
  if l.status <> 'draft' and length(v_reason) < 10 then
    raise exception 'Say what was wrong (at least 10 characters). It is kept on the audit trail.';
  end if;

  if p_rent_amount is null or p_rent_amount <= 0 then
    raise exception 'The rent has to be more than zero.';
  end if;
  if p_deposit_amount is null or p_deposit_amount < 0 then
    raise exception 'The deposit cannot be negative.';
  end if;
  if p_escalation_pct is null or p_escalation_pct < 0 or p_escalation_pct > 100 then
    raise exception 'The escalation must be between 0 and 100 percent.';
  end if;
  if p_start_date is null or p_end_date is null or p_end_date <= p_start_date then
    raise exception 'The tenancy has to end after it starts.';
  end if;
  if p_rent_frequency not in ('annual', 'quarterly', 'monthly') then
    raise exception 'That is not a rent frequency this system bills.';
  end if;

  if (l.rent_amount, l.rent_frequency::text, l.deposit_amount, l.escalation_pct, l.start_date, l.end_date)
     is not distinct from
     (p_rent_amount, p_rent_frequency, p_deposit_amount, p_escalation_pct, p_start_date, p_end_date) then
    raise exception 'Nothing has changed.';
  end if;

  perform set_config('app.lease_correction', l.id::text, true);
  update leases
     set rent_amount    = p_rent_amount,
         rent_frequency = p_rent_frequency::rent_frequency,
         deposit_amount = p_deposit_amount,
         escalation_pct = p_escalation_pct,
         start_date     = p_start_date,
         end_date       = p_end_date
   where id = l.id
  returning * into v_after;
  perform set_config('app.lease_correction', '', true);

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    l.org_id, v_me, 'lease.terms_corrected', 'lease', l.id,
    jsonb_build_object('status', l.status, 'rent_amount', l.rent_amount,
                       'rent_frequency', l.rent_frequency, 'deposit_amount', l.deposit_amount,
                       'escalation_pct', l.escalation_pct, 'start_date', l.start_date,
                       'end_date', l.end_date),
    jsonb_build_object('rent_amount', v_after.rent_amount,
                       'rent_frequency', v_after.rent_frequency, 'deposit_amount', v_after.deposit_amount,
                       'escalation_pct', v_after.escalation_pct, 'start_date', v_after.start_date,
                       'end_date', v_after.end_date, 'reason', nullif(v_reason, ''))
  );
end $$;

revoke all on function correct_lease_terms(uuid, numeric, text, numeric, numeric, date, date, text)
  from public, anon, service_role;
grant execute on function correct_lease_terms(uuid, numeric, text, numeric, numeric, date, date, text)
  to authenticated;

comment on function correct_lease_terms(uuid, numeric, text, numeric, numeric, date, date, text) is
  'Corrects a tenancy''s rent, frequency, deposit, escalation and dates. A draft freely; a live tenancy with a reason (>=10 chars) recorded on the audit trail; an ended one never. Demands already raised keep their figures. 0329.';

-- ── 2. A rent demand ───────────────────────────────────────────────────────
create or replace function correct_rent_charge(
  p_charge_id uuid,
  p_amount numeric,
  p_period_start date,
  p_period_end date,
  p_due_date date,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := active_uid();
  rc rent_charges%rowtype;
  l leases%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_mgmt numeric(16,2);
  v_net numeric(16,2);
begin
  if v_me is null then
    raise exception 'Sign in to do this.';
  end if;

  select * into rc from rent_charges where id = p_charge_id for update;
  if rc.id is null or rc.org_id is distinct from current_user_org_id() then
    raise exception 'That rent demand could not be found.';
  end if;
  select * into l from leases where id = rc.lease_id;

  if caller_is_owner_rep()
     or not coalesce(has_permission('leases.write'), false)
     or not (current_user_role() = any (oversight_roles())
             or l.property_id in (select current_user_property_ids())) then
    raise exception 'You do not have permission to correct this rent demand.';
  end if;

  if length(v_reason) < 10 then
    raise exception 'Say what was wrong (at least 10 characters). It is kept on the audit trail.';
  end if;

  -- Only a demand nothing has happened to.
  if rc.status <> 'due' or coalesce(rc.amount_paid, 0) > 0 then
    raise exception 'This demand has been paid or part-paid, so it is a record. A mistake on it is put right with a new demand or a credit, not by changing it.';
  end if;
  if rc.ledger_entry_id is not null or rc.remittance_id is not null or rc.remitted_at is not null then
    raise exception 'This demand has already reached the ledger, so it cannot be changed.';
  end if;
  if exists (select 1 from payment_intents pi
              where pi.rent_charge_id = rc.id and pi.status in ('pending', 'part_paid', 'paid')) then
    raise exception 'A payment request is open or paid against this demand. Cancel the request first, then correct it.';
  end if;
  if exists (select 1 from offline_payment_allocations a
               join offline_payment_claims c on c.id = a.claim_id
              where a.rent_charge_id = rc.id and c.status <> 'rejected') then
    raise exception 'A reported off-platform payment names this demand. Confirm or reject that report first.';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'The amount has to be more than zero.';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'The period must end after it starts.';
  end if;

  -- The fee at the rate frozen on this demand (decision 14), never today's.
  v_mgmt := round(p_amount * coalesce(rc.management_fee_pct, 0) / 100.0, 2);
  v_net := p_amount - v_mgmt - coalesce(rc.admin_fee_amount, 0);
  if v_net < 0 then
    raise exception 'At that amount the fees would exceed the rent. Check the figure.';
  end if;

  if (rc.amount, rc.period_start, rc.period_end, rc.due_date)
     is not distinct from (p_amount, p_period_start, p_period_end, coalesce(p_due_date, p_period_start)) then
    raise exception 'Nothing has changed.';
  end if;

  update rent_charges
     set amount                = p_amount,
         period_start          = p_period_start,
         period_end            = p_period_end,
         due_date              = coalesce(p_due_date, p_period_start),
         management_fee_amount = v_mgmt,
         landlord_net_amount   = v_net
   where id = rc.id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    rc.org_id, v_me, 'rent_charge.corrected', 'rent_charge', rc.id,
    jsonb_build_object('amount', rc.amount, 'period_start', rc.period_start,
                       'period_end', rc.period_end, 'due_date', rc.due_date,
                       'management_fee_amount', rc.management_fee_amount,
                       'landlord_net_amount', rc.landlord_net_amount, 'lease_id', rc.lease_id),
    jsonb_build_object('amount', p_amount, 'period_start', p_period_start,
                       'period_end', p_period_end, 'due_date', coalesce(p_due_date, p_period_start),
                       'management_fee_amount', v_mgmt, 'landlord_net_amount', v_net,
                       'management_fee_pct', rc.management_fee_pct, 'reason', v_reason)
  );
end $$;

revoke all on function correct_rent_charge(uuid, numeric, date, date, date, text)
  from public, anon, service_role;
grant execute on function correct_rent_charge(uuid, numeric, date, date, date, text) to authenticated;

comment on function correct_rent_charge(uuid, numeric, date, date, date, text) is
  'Corrects an untouched rent demand (unpaid, no open or paid request, no off-platform claim, not posted or remitted) with a reason; the fee is recomputed at the rate frozen on the demand. 0329.';

-- ── 3. A service-charge budget: fix the inputs, re-issue ───────────────────
do $$
declare
  d text;
  acl_before text;
  o text := $o$  if new.status = 'void'
     and coalesce(current_setting('app.sc_budget_void', true), '') <> new.id::text then$o$;
  n text := $n$  -- 0329. An invoiced budget's figures match the invoices raised from it, so
  -- they change only through Correct and re-issue, which withdraws those
  -- invoices first and checks no money is attached.
  if old.status = 'invoiced'
     and coalesce(current_setting('app.sc_budget_correction', true), '') <> new.id::text
     and (new.total_amount is distinct from old.total_amount
          or new.apportion_method is distinct from old.apportion_method
          or new.status = 'draft') then
    raise exception 'An invoiced budget is corrected with Correct and re-issue, which withdraws its invoices first and checks that no money is attached.';
  end if;

  if new.status = 'void'
     and coalesce(current_setting('app.sc_budget_void', true), '') <> new.id::text then$n$;
begin
  select replace(pg_get_functiondef(p.oid), E'\r', ''), p.proacl::text into d, acl_before
    from pg_proc p where p.oid = 'public.guard_sc_budget_update()'::regprocedure;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0329: guard_sc_budget_update — expected the void clause exactly once';
  end if;
  execute replace(d, o, n);
  if (select p.proacl::text from pg_proc p where p.oid = 'public.guard_sc_budget_update()'::regprocedure)
     is distinct from acl_before then
    raise exception '0329: guard_sc_budget_update — grants changed by the rebuild';
  end if;
end $$;

create or replace function reopen_sc_budget_for_correction(
  p_budget_id uuid,
  p_total_amount numeric,
  p_description text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := active_uid();
  b sc_budgets%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_money int;
  v_claims int;
  v_retired int;
begin
  if v_me is null then
    raise exception 'Sign in to do this.';
  end if;

  select * into b from sc_budgets where id = p_budget_id for update;
  if b.id is null or b.org_id is distinct from current_user_org_id() then
    raise exception 'That budget could not be found.';
  end if;

  -- `sc_budgets_update`, restated because DEFINER bypasses it (as void_sc_budget).
  if caller_is_owner_rep()
     or not coalesce(has_permission('sc.manage'), false)
     or not (current_user_role() = any (oversight_roles())
             or b.property_id in (select current_user_property_ids())) then
    raise exception 'You do not have permission to correct this budget.';
  end if;

  if b.status = 'void' then
    raise exception 'This budget was voided, so it can no longer be changed. Raise a new budget instead.';
  end if;
  if b.status <> 'invoiced' then
    raise exception 'This budget has not been invoiced yet — change it directly and generate the invoices when it is right.';
  end if;
  if length(v_reason) < 10 then
    raise exception 'Say what was wrong (at least 10 characters). It is kept on the audit trail.';
  end if;
  if p_total_amount is not null and p_total_amount <= 0 then
    raise exception 'The budget total has to be more than zero.';
  end if;

  -- void_sc_budget's money test, unchanged: seen in full, not through the
  -- caller's own read scope (0292).
  select count(*) into v_money
  from service_charges sc
  where sc.budget_id = p_budget_id
    and sc.deleted_at is null
    and (
      coalesce(sc.amount_paid, 0) > 0
      or sc.status in ('paid', 'part_paid')
      or exists (
        select 1 from payment_intents pi
        where pi.service_charge_id = sc.id
          and pi.status in ('pending', 'part_paid', 'paid')
      )
    );
  if v_money > 0 then
    raise exception 'This budget cannot be re-issued: % of its invoices % a payment request that is open or has been paid. Money attached to an invoice has to be dealt with first.',
      v_money, case when v_money = 1 then 'has' else 'have' end;
  end if;

  select count(*) into v_claims
  from offline_payment_allocations a
  join offline_payment_claims c on c.id = a.claim_id
  join service_charges sc on sc.id = a.service_charge_id
  where sc.budget_id = p_budget_id
    and sc.deleted_at is null
    and c.status <> 'rejected';
  if v_claims > 0 then
    raise exception 'This budget cannot be re-issued: a reported off-platform payment names one of its invoices. Confirm or reject that report first.';
  end if;

  perform set_config('app.sc_budget_correction', b.id::text, true);

  update service_charges
     set deleted_at = now()
   where budget_id = p_budget_id and deleted_at is null;
  get diagnostics v_retired = row_count;

  update sc_budgets
     set total_amount = coalesce(p_total_amount, total_amount),
         description  = coalesce(nullif(btrim(p_description), ''), description),
         status       = 'draft'
   where id = b.id;

  perform set_config('app.sc_budget_correction', '', true);

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    b.org_id, v_me, 'sc_budget.reopened_for_correction', 'sc_budget', b.id,
    jsonb_build_object('status', b.status, 'total_amount', b.total_amount, 'description', b.description),
    jsonb_build_object('status', 'draft',
                       'total_amount', coalesce(p_total_amount, b.total_amount),
                       'description', coalesce(nullif(btrim(p_description), ''), b.description),
                       'invoices_withdrawn', v_retired, 'reason', v_reason)
  );

  return v_retired;
end $$;

revoke all on function reopen_sc_budget_for_correction(uuid, numeric, text, text)
  from public, anon, service_role;
grant execute on function reopen_sc_budget_for_correction(uuid, numeric, text, text) to authenticated;

comment on function reopen_sc_budget_for_correction(uuid, numeric, text, text) is
  'Fix the inputs, re-issue: withdraws an invoiced budget''s invoices, corrects its total/description and returns it to draft, with a reason on the audit trail. Refused on void_sc_budget''s money test. 0329.';

-- ── 4. Assertions ──────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name in ('correct_lease_terms', 'correct_rent_charge', 'reopen_sc_budget_for_correction')
                and grantee in ('PUBLIC', 'anon', 'service_role')) then
    raise exception '0329: a correction function is callable beyond signed-in users';
  end if;
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public'
                and routine_name = 'guard_live_lease_terms'
                and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) then
    raise exception '0329: the lease guard is executable by a client role';
  end if;
  if not exists (select 1 from pg_proc where proname = 'guard_sc_budget_update'
                    and prosrc like '%app.sc_budget_correction%'
                    and prosrc like '%app.sc_budget_void%'
                    and prosrc like '%cannot be moved to another property%') then
    raise exception '0329: guard_sc_budget_update lost a clause in the rebuild';
  end if;
end $$;
