-- 📌 6 Oct 2026. A service-charge budget raised in error had no way out.
--
-- Asked from OEA production: a ₦100 test budget, invoiced to a deactivated
-- tenant, and "how do I delete the created test budget?" — then "can a budget
-- be unlinked from a property if attached in error?". Measured, not assumed:
--
--   • No screen deletes a budget, draft or otherwise.
--   • An invoiced budget CANNOT be deleted at all: `service_charges` is
--     soft-delete only (`service_charges_no_hard_delete`, 0010), so a retired
--     invoice stays, and `service_charges_budget_id_fkey` then refuses the
--     budget's delete. That is right — an invoice is a financial record — and
--     it left a mistake permanent.
--   • `authenticated` holds table-level UPDATE on `sc_budgets`, `property_id`
--     and `status` included, and nothing refuses either. So the one "fix" the
--     schema offered — re-pointing the budget at the right property through a
--     direct API call — was open, and is the wrong fix three times over: the
--     invoices were apportioned across the OLD property's units; statements
--     and the per-property fund (0247) find a budget's money through its
--     property, so collected money would silently move buildings; and 0109's
--     one-budget-per-property-period could be walked around.
--
-- So, three acts:
--
--   1. A budget's property (and org) is fixed once it exists. A mistake is
--      voided and raised again on the right property — never moved.
--   2. VOID (`void_sc_budget`): retires every live invoice on the budget and
--      marks it void, with who, when and a stated reason. Refused while any
--      money is attached — a payment request that is open or has paid, or an
--      off-platform claim that has not been rejected — because voiding an
--      invoice somebody is paying, or has paid, would orphan the money.
--      A void budget is closed: nothing on it changes again, nothing new is
--      invoiced against it, and it frees its property + period for the
--      correctly filed budget (the 0109 index now ignores void rows).
--   3. DELETE, for a budget nothing ever referenced (a draft with no
--      invoices). Already permitted by `sc_budgets_delete` (0236) and already
--      made impossible for anything else by the foreign key; what was missing
--      was a trace. `audit_budgets` logged status changes only, so a deletion
--      now writes its own audit row carrying the whole deleted row.
--
-- ⚠️ The status can only become `void` through `void_sc_budget`. Table-level
-- UPDATE means a caller could otherwise PATCH `status = 'void'` and skip the
-- money check — the 0216 shape (a vendor filing their own registration as
-- approved). The function sets a transaction-local flag naming the budget;
-- the trigger refuses the transition without it.
--
-- 📌 Two readers counted every budget regardless of state: `bi_budget_utilisation`
-- and `bi_financials.total_budgeted`. A voided budget would have gone on
-- inflating "budgeted" on the dashboard. Both are rebuilt from
-- `pg_get_viewdef` output with one clause added each, security_invoker kept.
-- The statements (`property_statement`, `landlord_statement`, …) read the
-- invoices, which a void retires, so they needed nothing.

-- ── Columns and rules ────────────────────────────────────────────────────────

alter table sc_budgets
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references users(id),
  add column if not exists void_reason text;

alter table sc_budgets
  add constraint sc_budgets_status_known
    check (status in ('draft', 'invoiced', 'void'));

alter table sc_budgets
  add constraint sc_budgets_void_is_attributed
    check (
      (status = 'void') = (voided_at is not null)
      and (status <> 'void' or (
        voided_by is not null
        and void_reason is not null
        and length(btrim(void_reason)) >= 10
      ))
    );

-- 0109's rule, minus the budgets that no longer exist in substance. Voiding a
-- budget filed on the wrong property, or in the wrong period, must free that
-- slot for the correct one.
drop index if exists sc_budgets_one_per_property_period_uidx;
create unique index sc_budgets_one_per_property_period_uidx
  on sc_budgets (property_id, lower(btrim(period)))
  where status <> 'void';

-- ── The guard on every update ───────────────────────────────────────────────

create or replace function public.guard_sc_budget_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'void' then
    raise exception 'This budget was voided, so it can no longer be changed. Raise a new budget instead.';
  end if;

  if new.property_id is distinct from old.property_id then
    raise exception 'A budget cannot be moved to another property. Void it and raise a new budget on the right property.';
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'A budget cannot be moved to another organisation.';
  end if;

  if new.status = 'void'
     and coalesce(current_setting('app.sc_budget_void', true), '') <> new.id::text then
    raise exception 'A budget is voided with Void budget, which checks that no money is attached to it first.';
  end if;

  if new.status <> 'void' and (
       new.voided_at is not null or new.voided_by is not null or new.void_reason is not null
     ) then
    raise exception 'Only a voided budget carries void details.';
  end if;

  return new;
end;
$$;

drop trigger if exists sc_budgets_guard_update on sc_budgets;
create trigger sc_budgets_guard_update
  before update on sc_budgets
  for each row execute function guard_sc_budget_update();

-- Nothing is invoiced against a void budget, and no retired invoice of one is
-- brought back. Written on the invoice table so every write path meets it.
create or replace function public.refuse_invoice_on_void_budget()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.budget_id is not null and new.deleted_at is null
     and exists (select 1 from sc_budgets b where b.id = new.budget_id and b.status = 'void') then
    raise exception 'That budget was voided, so nothing can be invoiced against it.';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_invoice_on_void_budget() from public, anon, authenticated, service_role;

drop trigger if exists service_charges_refuse_void_budget on service_charges;
create trigger service_charges_refuse_void_budget
  before insert or update of deleted_at, budget_id on service_charges
  for each row execute function refuse_invoice_on_void_budget();

-- Voiding is a status change, so `audit_budgets` already records it with the
-- before/after row (reason included). A deletion was recorded nowhere.
drop trigger if exists audit_budgets_delete on sc_budgets;
create trigger audit_budgets_delete
  after delete on sc_budgets
  for each row execute function log_audit('sc_budget.deleted');

-- ── Void ────────────────────────────────────────────────────────────────────

create or replace function public.void_sc_budget(p_budget_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := active_uid();
  v_org_id uuid;
  v_property_id uuid;
  v_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_money int;
  v_claims int;
begin
  if v_me is null then
    raise exception 'Sign in to do this.';
  end if;

  select b.org_id, b.property_id, b.status
    into v_org_id, v_property_id, v_status
  from sc_budgets b where b.id = p_budget_id
  for update;

  if v_org_id is null or v_org_id is distinct from current_user_org_id() then
    raise exception 'That budget could not be found.';
  end if;

  -- The same authorisation as `sc_budgets_update`, restated because DEFINER
  -- bypasses it: sc.manage, plus oversight or the caller's own place.
  if not coalesce(has_permission('sc.manage'), false)
     or not (
       current_user_role() = any (oversight_roles())
       or v_property_id in (select current_user_property_ids())
     ) then
    raise exception 'You do not have permission to void this budget.';
  end if;

  if v_status = 'void' then
    raise exception 'This budget has already been voided.';
  end if;

  if length(v_reason) < 10 then
    raise exception 'Say why this budget is being voided (at least 10 characters). It is kept on the record.';
  end if;

  -- Money attached to any live invoice, seen in full rather than through the
  -- caller's own read scope (0292's reasoning: a regional manager holds
  -- sc.manage and is not admitted by payment_intents_select).
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
    raise exception 'This budget cannot be voided: % of its invoices % a payment request that is open or has been paid. Money attached to an invoice has to be dealt with first.',
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
    raise exception 'This budget cannot be voided: a reported off-platform payment names one of its invoices. Confirm or reject that report first.';
  end if;

  perform set_config('app.sc_budget_void', p_budget_id::text, true);

  update service_charges
     set deleted_at = now()
   where budget_id = p_budget_id and deleted_at is null;

  update sc_budgets
     set status = 'void',
         voided_at = now(),
         voided_by = v_me,
         void_reason = v_reason
   where id = p_budget_id;

  perform set_config('app.sc_budget_void', '', true);
end;
$$;

comment on function public.void_sc_budget(uuid, text) is
  'Voids a service-charge budget raised in error (0315): retires its live invoices and marks it void with who, when and why. Refused while any money is attached to an invoice (an open or paid payment request, a payment recorded on it, or an off-platform claim not rejected). The only way a budget becomes void — guard_sc_budget_update refuses the transition without this function''s transaction-local flag.';

revoke all on function public.void_sc_budget(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.void_sc_budget(uuid, text) to authenticated;

revoke all on function public.guard_sc_budget_update() from public, anon, authenticated, service_role;

-- ── The two dashboard readers ───────────────────────────────────────────────
-- Rebuilt from pg_get_viewdef with one clause each; columns, order and
-- security_invoker unchanged.

create or replace view public.bi_budget_utilisation with (security_invoker = on) as
 SELECT b.id AS budget_id,
    b.org_id,
    b.property_id,
    p.name AS property_name,
    b.total_amount AS budgeted,
    ( SELECT COALESCE(sum(sc.amount), (0)::numeric) AS "coalesce"
           FROM service_charges sc
          WHERE ((sc.budget_id = b.id) AND (sc.deleted_at IS NULL))) AS invoiced,
    ( SELECT COALESCE(sum(sc.amount), (0)::numeric) AS "coalesce"
           FROM service_charges sc
          WHERE ((sc.budget_id = b.id) AND (sc.deleted_at IS NULL) AND (sc.status = 'paid'::text))) AS collected
   FROM (sc_budgets b
     LEFT JOIN properties p ON ((p.id = b.property_id)))
  WHERE (b.status <> 'void'::text);

create or replace view public.bi_financials with (security_invoker = on) as
 SELECT id AS org_id,
    ( SELECT COALESCE(sum(sc.amount), (0)::numeric) AS "coalesce"
           FROM service_charges sc
          WHERE ((sc.org_id = o.id) AND (sc.deleted_at IS NULL))) AS total_invoiced,
    ( SELECT COALESCE(sum(sc.amount), (0)::numeric) AS "coalesce"
           FROM service_charges sc
          WHERE ((sc.org_id = o.id) AND (sc.deleted_at IS NULL) AND (sc.status = 'paid'::text))) AS total_collected,
    ( SELECT COALESCE(sum(p.amount), (0)::numeric) AS "coalesce"
           FROM payments p
          WHERE ((p.org_id = o.id) AND (p.status <> ALL (ARRAY['remitted'::payment_status, 'rejected'::payment_status])))) AS vendor_liabilities,
    ( SELECT COALESCE(sum(b.total_amount), (0)::numeric) AS "coalesce"
           FROM sc_budgets b
          WHERE ((b.org_id = o.id) AND (b.status <> 'void'::text))) AS total_budgeted
   FROM orgs o;

-- ── Assertions ──────────────────────────────────────────────────────────────

do $$
declare
  v_grantees text[];
  v_opts text[];
begin
  -- The fifth-instance grant lesson (0264, 0281, 0292): authenticated only.
  select array_agg(distinct grantee order by grantee) into v_grantees
  from information_schema.routine_privileges
  where routine_schema = 'public' and routine_name = 'void_sc_budget'
    and privilege_type = 'EXECUTE';
  if not ('authenticated' = any (v_grantees))
     or 'anon' = any (v_grantees) or 'service_role' = any (v_grantees) or 'PUBLIC' = any (v_grantees) then
    raise exception '0315 assertion failed: void_sc_budget grants are %', v_grantees;
  end if;

  if (select prosecdef from pg_proc where oid = 'public.void_sc_budget(uuid,text)'::regprocedure) is distinct from true then
    raise exception '0315 assertion failed: void_sc_budget must be SECURITY DEFINER';
  end if;

  -- The rebuilt views kept security_invoker.
  for v_opts in
    select reloptions from pg_class where relname in ('bi_budget_utilisation', 'bi_financials')
  loop
    if not ('security_invoker=on' = any (coalesce(v_opts, '{}'))) then
      raise exception '0315 assertion failed: a rebuilt BI view lost security_invoker';
    end if;
  end loop;

  -- Every existing budget satisfies the new rules (none is void yet).
  if exists (select 1 from sc_budgets where status not in ('draft', 'invoiced')) then
    raise exception '0315 assertion failed: a budget carries an unknown status';
  end if;
end $$;
