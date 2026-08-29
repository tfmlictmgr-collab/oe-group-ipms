-- A tenant's own statement could not say which flat, or which building.
--
-- Found by rendering the new tenancy page (0225's sibling) as the tenant
-- themselves, on staging, against real data: the heading came back
-- **"Unit — Property"** and the Property card read **"Property"**. Those are the
-- page's fallback strings. Every figure on it was correct and the one thing a
-- statement has to establish — WHOSE HOME THIS IS ABOUT — was missing.
--
-- Two policies, and neither was wrong for the case it was written for:
--
--   **`properties_select`** admits `properties.read_all` or a property resolved
--   by `current_user_property_ids()`. A tenant holds neither and never will:
--   they are not staff and they are not a stakeholder. So a tenant has never
--   been able to read the property they rent. Not a regression — it has been
--   true since the register was built, and it went unnoticed because until now
--   nothing on a tenant-facing screen named a property. `my_service_charges()`
--   and `my_payment_history()` are both SECURITY DEFINER for exactly this
--   reason, and 0123's own comment says so out loud: they join properties
--   because *"a tenant has no direct read on"* them.
--
--   **`units_select`** does admit `occupant_user_id = auth.uid()` — the right
--   idea, and the wrong fact. Measured live: **16 of 18 live tenancies** have a
--   unit whose occupant is not the tenant, almost all of them because the
--   occupant is null. That is 0200's finding from the read side. `activate_lease`
--   skips the occupant entirely for a company let or a tenant with no portal
--   user, and invitation acceptance sets an occupant while writing no lease.
--   Occupancy and tenancy are two different facts, so a policy that asks only
--   the first answers "no" to most real tenants.
--
-- ⚠️ `current_user_property_ids()` IS NOT TOUCHED. 0184's lesson is the whole
-- shape of this migration: the resolver was right and the CONSUMER was wrong.
-- It is referenced by 42 policy clauses, it deliberately does not filter on
-- relation, and teaching it about tenancies would hand every tenant whatever
-- those 42 clauses grant. The branch goes in the two policies that need it, and
-- says which case it is for — the same way `units_select` already names its
-- occupant case.
--
-- **Bounded to the lease, not to the lease's status**, and that is deliberate.
-- `leases_select` lets a tenant read their own tenancy with no status test at
-- all. Naming the place more tightly than the tenancy itself would reproduce
-- exactly the contradiction being fixed: a statement a person may open that
-- cannot say where it is. A former tenant keeps the record of where they lived,
-- which is what a record is for.
--
-- Both policies are rewritten MECHANICALLY FROM THE LIVE CATALOGUE
-- (`pg_policies.qual`), never retyped from the migration that last defined them
-- — 0183's rule. Everything before the new `or` below is byte-for-byte what was
-- deployed; a clause lost to a typo here would silently narrow who can see the
-- property register.

/**
 * Is the caller the tenant of record on a tenancy at this place?
 *
 * One helper, two consumers, so the two policies cannot drift into disagreeing
 * about what "the tenant lives here" means — which is the fault 0200 corrected
 * for vacancy and this file is correcting for naming.
 *
 * Deliberately NOT a new scoping mechanism (decision 8): it resolves nothing and
 * grants nothing. It answers one yes/no about the caller, and it is called only
 * from inside the two policies below.
 */
create or replace function caller_is_tenant_of_place(p_property_id uuid, p_unit_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from leases l
     where l.tenant_user_id = auth.uid()
       and l.deleted_at is null
       and l.org_id = current_user_org_id()
       and (
         (p_unit_id is not null and l.unit_id = p_unit_id)
         or (p_unit_id is null and p_property_id is not null and l.property_id = p_property_id)
       )
  );
$$;

-- 0209/0210/0214 reproduced the missing revoke three times in this repo. A
-- SECURITY DEFINER function taking caller-supplied ids ships callable by `anon`
-- unless this is stated, and `create or replace` re-applies the default grant
-- even on a function a previous migration correctly closed.
revoke all on function caller_is_tenant_of_place(uuid, uuid) from public;
revoke execute on function caller_is_tenant_of_place(uuid, uuid) from anon;
grant execute on function caller_is_tenant_of_place(uuid, uuid) to authenticated;

comment on function caller_is_tenant_of_place is
  'True when the caller is the tenant of record on a non-deleted lease at this unit (or, with a null unit, this property). Answers one question about the caller and resolves nothing -- it is not a second scoping mechanism, and current_user_property_ids() remains the only resolver (decision 8). Bounded to the lease rather than to its status, so a statement can always name the place it is about, exactly as leases_select can always be opened.';

-- ── The two consumers ─────────────────────────────────────────────────────

drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    (deleted_at is null)
    and (org_id = current_user_org_id())
    and (
      (select has_permission('properties.read_all'::text))
      or (id in (select current_user_property_ids()))
      -- New. A tenant reads the building they rent, and no other.
      or caller_is_tenant_of_place(id, null)
    )
  );

drop policy if exists units_select on units;
create policy units_select on units for select
  using (
    (deleted_at is null)
    and (org_id = current_user_org_id())
    and (
      (occupant_user_id = auth.uid())
      or (select has_permission('properties.read_all'::text))
      or (select has_permission('sc.read_all'::text))
      or (property_id in (select current_user_property_ids()))
      -- New. The occupant branch above is the same intention against a
      -- different fact, and it answers "no" for 16 of 18 live tenancies.
      or caller_is_tenant_of_place(property_id, id)
    )
  );

comment on policy properties_select on properties is
  'Staff with properties.read_all, anyone the property resolves to through current_user_property_ids(), and the tenant of a tenancy on it -- who could not previously read the building they rent, so their own statement could not name it (0226).';

comment on policy units_select on units is
  'The recorded occupant, staff with properties.read_all or sc.read_all, anyone the property resolves to, and the tenant of a tenancy on the unit. The last is not the same as the first: occupancy and tenancy are different facts (0200), and 16 of 18 live tenancies had no matching occupant.';
