-- 📌 12 Sept 2026. Decision 26's own recorded-not-fixed gap, closed:
-- "service_charges has no DELETE policy and a no_hard_delete trigger, so
-- generateInvoices's delete-then-reinsert clears nothing under RLS and would
-- duplicate a budget's invoices on a regenerate ... a control in the wrong
-- layer, unchanged in risk by this turn, and owed its own."
--
-- Measured on the live catalogue: `service_charges` carries INSERT, SELECT and
-- UPDATE policies and NO DELETE policy at all. With row-level security ON and
-- no permissive policy for a command, that command matches ZERO rows and
-- Postgres raises NO error — so app/dashboard/sc/[id]/actions.ts's
-- `.delete().eq('budget_id', ...)` has always been a silent no-op. The
-- "a payment has already been requested" refusal that comment describes,
-- keyed off a foreign-key violation from `payment_intents_service_charge_id_fkey`,
-- has never once fired: with zero rows deleted there is no foreign key for
-- anything to violate. Regenerating a budget's invoices has been silently
-- ADDING a second set alongside the first, guarded only by the UI disabling
-- the button once `status = 'invoiced'` — exactly the "control in the wrong
-- layer" the decision named.
--
-- ⚠️ The fix is not a DELETE policy. `service_charges_no_hard_delete`
-- (0027-era) refuses a hard delete outright for every authenticated caller
-- (`auth.uid() is not null`) regardless of what any policy would admit —
-- opening a DELETE policy would only route a real attempt into that refusal,
-- never into the "clear the old invoices" behaviour the action wants. This
-- table is soft-delete only, matching guardrail A3 ("immutable audit logs,
-- soft-delete only"), and `deleted_at` has existed on it since day one for
-- exactly this. `retire_service_charges_for_regenerate` retires the prior
-- invoices with a plain UPDATE (which the existing sc.manage + place policy
-- already governs) after checking — under FULL visibility, not the caller's
-- own scoped SELECT — that none of them has a live payment_intents row
-- against it.
--
-- 📌 Full visibility is deliberate, not a shortcut. `sc.manage` is held by
-- admin, finance, property_manager AND regional_manager (decisions 26/29), but
-- `payment_intents_select` admits only oversight or `property_finance_roles()`
-- — decision 29's own footnote, and it does NOT include regional_manager. A
-- check run under the regional manager's own session would silently
-- undercount referencing payments and wrongly allow the regenerate through.
-- This is the actual duplicate-prevention boundary now (there is no longer a
-- foreign-key violation behind it), so it has to see every reference, not only
-- the ones its caller's own role happens to read.

create or replace function public.retire_service_charges_for_regenerate(p_budget_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_property_id uuid;
  v_referenced int;
  v_caller_org uuid := current_user_org_id();
  v_caller_role user_role := current_user_role();
begin
  if auth.uid() is null then
    raise exception 'Sign in to do this.';
  end if;

  select b.org_id, b.property_id into v_org_id, v_property_id
  from sc_budgets b where b.id = p_budget_id;

  if v_org_id is null or v_org_id is distinct from v_caller_org then
    raise exception 'That budget could not be found.';
  end if;

  -- Same authorisation as the UPDATE policy this replaces: sc.manage, plus
  -- oversight or the caller's own place.
  if not coalesce(has_permission('sc.manage'), false) then
    raise exception 'You do not have permission to change how this budget is split.';
  end if;

  if not (
    v_caller_role = any (oversight_roles())
    or v_property_id in (select current_user_property_ids())
  ) then
    raise exception 'You do not have permission to change how this budget is split.';
  end if;

  select count(*) into v_referenced
  from payment_intents pi
  join service_charges sc on sc.id = pi.service_charge_id
  where sc.budget_id = p_budget_id and sc.deleted_at is null;

  if v_referenced > 0 then
    raise exception 'PAYMENT_REQUESTED: a payment has already been requested against at least one of these invoices.';
  end if;

  update service_charges
     set deleted_at = now()
   where budget_id = p_budget_id and deleted_at is null;
end;
$$;

comment on function public.retire_service_charges_for_regenerate(uuid) is
  'Retires (soft-deletes) every live invoice on a budget so generateInvoices can insert a fresh set, refusing when a payment has already been requested against one of them. SECURITY DEFINER because that check must see every payment_intents row regardless of the caller''s own read scope (0292) — sc.manage is held by regional_manager, who payment_intents_select does not admit. Re-asserts the UPDATE policy''s own authorisation inline rather than relying on RLS, since DEFINER bypasses it.';

revoke all on function public.retire_service_charges_for_regenerate(uuid) from public, anon, authenticated, service_role;
grant execute on function public.retire_service_charges_for_regenerate(uuid) to authenticated;

-- ── The suite that must catch a regression here ─────────────────────────────
-- Asserted directly: the function exists, is SECURITY DEFINER, is granted to
-- `authenticated`, and is granted to none of the roles it must never be
-- reachable from — the fifth-instance grant lesson (0264, 0281) applied on the
-- day the function is written. (The owning role, typically `postgres`, always
-- carries an implicit EXECUTE grant of its own and is not part of this check.)
do $$
declare
  v_is_definer boolean;
  v_grantees text[];
begin
  select p.prosecdef into v_is_definer
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'retire_service_charges_for_regenerate';

  if v_is_definer is distinct from true then
    raise exception '0292 assertion failed: retire_service_charges_for_regenerate must be SECURITY DEFINER';
  end if;

  select array_agg(distinct grantee order by grantee) into v_grantees
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'retire_service_charges_for_regenerate'
    and privilege_type = 'EXECUTE';

  if not ('authenticated' = any (v_grantees)) then
    raise exception '0292 assertion failed: retire_service_charges_for_regenerate is not granted to authenticated (%)', v_grantees;
  end if;

  if (select count(*) from information_schema.routine_privileges
       where routine_schema = 'public'
         and routine_name = 'retire_service_charges_for_regenerate'
         and grantee in ('anon', 'service_role', 'PUBLIC')) > 0 then
    raise exception '0292 assertion failed: retire_service_charges_for_regenerate is reachable from anon, service_role or PUBLIC (%)', v_grantees;
  end if;
end $$;
