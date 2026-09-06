-- A rent roll arrives as a file, and the tenant of record has a name.
--
-- Asked as "there should be bulk upload/import" on the tenancy schedule. That
-- schedule IS `private/MANAGEMENT PORTFOLIO.xlsx` rendered live (0254), and the
-- reason it renders empty for OEA is that thirteen sheets of tenancies have
-- never been entered — one at a time, through a form, is not a migration path
-- for a portfolio that is already let.
--
-- ⚠️ But importing a rent roll surfaced a gap that had to be closed first.
--
-- `leases.tenant_user_id` is nullable and `tenancy_schedule` reads the tenant's
-- name off the joined `users` row. That is right for a tenant with a portal
-- account and wrong for everybody else: decision 22 already records that a
-- COMPANY LET has no portal user, and `activate_lease` skips the occupant
-- entirely in that case. The workbook's own second column is NAME OF TENANT and
-- it is never blank. So today a company let — and every row of any import —
-- renders with no tenant at all, on the one report whose whole purpose is to
-- say who is in which unit.
--
--   `leases.tenant_name` / `leases.tenant_phone` are the tenant OF RECORD when
--   there is no account. Not a second source of truth for one who has an
--   account: the view coalesces the joined user FIRST, so a portal identity
--   always wins and these are only ever read when there is nothing to win
--   against. Creating account-less `users` rows instead would have put a
--   non-person into the table that role, invitation and RLS all key off.
--
-- ⚠️ `import_tenancies` is SECURITY **INVOKER**, deliberately, and that is the
-- whole of its access control. `leases_write` (0090) already says: the caller's
-- org, plus `leases.write`, plus oversight-or-`current_user_property_ids()`. A
-- definer function would have had to restate all three, and a restated policy
-- is a policy with two versions — which is what 0184 had to go back and fix on
-- `tickets_select` and what decision 8 forbids in general. Running as the caller
-- means RLS vets every inserted row with the same clause the single-tenancy form
-- is vetted by, and a property manager importing a file of 200 tenancies can
-- still only write onto buildings they hold.
--
-- ⚠️ And it is ONE transaction. A half-imported rent roll is worse than none:
-- the totals are wrong, the landlord statements are wrong, and nobody can tell
-- which half landed. A row that fails names itself and takes the whole import
-- down with it, which is recoverable; a partial success is not.

-- ── The tenant of record ────────────────────────────────────────────────────

alter table leases add column if not exists tenant_name  text;
alter table leases add column if not exists tenant_phone text;

comment on column leases.tenant_name is
  'The tenant of record when there is no portal account — a company let (decision 22), or a tenancy imported from the managed portfolio. `tenancy_schedule` coalesces the JOINED user first, so this is never consulted for a tenant who holds an account and can never contradict one.';
comment on column leases.tenant_phone is
  'As tenant_name. The workbook''s PHONE column, for a tenancy with no portal user to carry it.';

-- ── The schedule reads it ───────────────────────────────────────────────────
--
-- Rebuilt from `pg_get_viewdef` with exactly two expressions changed (0183's
-- rule: the live catalogue is the source, never the migration that last wrote
-- it). Everything else — the owner lateral, the rent-charge lateral, the
-- service-charge window, the audience predicate — is byte-identical.
create or replace view tenancy_schedule
with (security_invoker = on) as
 SELECT l.id AS lease_id,
    l.org_id,
    l.created_at AS recorded_at,
    l.property_id,
    p.name AS property_name,
    p.address AS property_address,
    p.property_type,
    own.user_id AS owner_user_id,
    ownu.full_name AS owner_name,
    ownu.email AS owner_email,
    l.unit_id,
    unit_display_label(u.label, u.description) AS unit_label,
    u.apportionment_factor AS unit_space,
    l.tenant_user_id,
    -- ⚠️ The joined user FIRST. A tenant who holds an account is who they are
    -- in `users`; the columns on the lease exist for the case where there is no
    -- such row, and must never be able to overwrite one that exists.
    COALESCE(t.full_name, l.tenant_name) AS tenant_name,
    t.email AS tenant_email,
    COALESCE(t.phone, l.tenant_phone) AS tenant_phone,
    l.status,
    l.start_date,
    l.end_date,
    l.end_date - CURRENT_DATE AS days_to_expiry,
    l.rent_amount,
    l.rent_frequency,
    l.currency,
    l.escalation_pct,
    COALESCE(c.billed, 0::numeric) AS rent_billed,
    COALESCE(c.collected, 0::numeric) AS rent_collected,
    COALESCE(c.billed, 0::numeric) - COALESCE(c.collected, 0::numeric) AS rent_outstanding,
    c.fee_pct AS management_fee_pct,
    COALESCE(c.mgmt_fees, 0::numeric) AS management_fees,
    COALESCE(c.admin_fees, 0::numeric) AS admin_fees,
    COALESCE(c.landlord_net, 0::numeric) AS landlord_net,
    COALESCE(sc.sc_billed, 0::numeric) AS service_charge_billed,
    COALESCE(sc.sc_collected, 0::numeric) AS service_charge_collected,
    COALESCE(sc.sc_billed, 0::numeric) - COALESCE(sc.sc_collected, 0::numeric) AS service_charge_outstanding,
    l.notes AS remark
   FROM leases l
     JOIN properties p ON p.id = l.property_id
     JOIN units u ON u.id = l.unit_id
     LEFT JOIN users t ON t.id = l.tenant_user_id
     LEFT JOIN LATERAL ( SELECT s.user_id
           FROM property_stakeholders s
          WHERE s.property_id = l.property_id AND s.relation = 'owner'::property_relation
          ORDER BY s.created_at, s.user_id
         LIMIT 1) own ON true
     LEFT JOIN users ownu ON ownu.id = own.user_id
     LEFT JOIN LATERAL ( SELECT sum(rc.amount) AS billed,
            sum(rc.amount_paid) AS collected,
            sum(rc.management_fee_amount) AS mgmt_fees,
            sum(rc.admin_fee_amount) AS admin_fees,
            sum(rc.landlord_net_amount) AS landlord_net,
            max(rc.management_fee_pct) AS fee_pct
           FROM rent_charges rc
          WHERE rc.lease_id = l.id) c ON true
     LEFT JOIN LATERAL ( SELECT sum(s.amount) AS sc_billed,
            sum(s.amount_paid) AS sc_collected
           FROM service_charges s
          WHERE s.unit_id = l.unit_id AND s.deleted_at IS NULL AND s.created_at >= l.start_date AND s.created_at < (l.end_date + 1)) sc ON true
  WHERE l.deleted_at IS NULL AND ((current_user_role() = ANY (oversight_roles())) OR (l.property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids)));

comment on view tenancy_schedule is
  'One row per tenancy, carrying every column the MANAGEMENT PORTFOLIO workbook keeps by hand — landlord, address, unit, tenant, term, rent, service charge, fee at the rate that applied, and the remark (0254). Since 0265 the tenant name falls back to the lease''s own tenant-of-record columns, so a company let and an imported tenancy are not blank in the one column the workbook never leaves blank.';

-- ⚠️ A `create or replace view` re-applies Supabase's defaults. Named again for
-- the same reason 0254 named it, and asserted rather than assumed.
revoke all on tenancy_schedule from public, anon;
grant select on tenancy_schedule to authenticated, service_role;

do $$
declare v_bad text;
begin
  select string_agg(grantee, ', ')
    into v_bad
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'tenancy_schedule'
     and grantee in ('anon', 'PUBLIC');
  if v_bad is not null then
    raise exception 'tenancy_schedule is readable by % and must not be', v_bad;
  end if;
end $$;

-- ── The import ──────────────────────────────────────────────────────────────

create or replace function import_tenancies(p_rows jsonb)
returns jsonb
language plpgsql
security invoker            -- ⚠️ see the header: RLS is the access control
set search_path = public
as $fn$
declare
  r          jsonb;
  v_lease_id uuid;
  v_row      text;
  v_inserted integer := 0;
  v_activated integer := 0;
  v_ids      uuid[] := '{}';
  v_count    integer;
begin
  v_count := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  if v_count = 0 then
    raise exception 'there is nothing in that file to import';
  end if;
  -- A ceiling, because this is one transaction and one transaction should not
  -- be unbounded. 500 rows is more than any single sheet of the workbook this
  -- exists to replace; a bigger portfolio is imported a sheet at a time, which
  -- is also how somebody can check each one.
  if v_count > 500 then
    raise exception 'that file has % tenancies — import at most 500 at a time', v_count;
  end if;

  -- Said in plain words here. RLS refuses it regardless, on every row.
  if not (select has_permission('leases.write')) then
    raise exception 'you do not hold leases.write, so you cannot record tenancies';
  end if;

  for r in select * from jsonb_array_elements(p_rows)
  loop
    v_row := coalesce(r->>'row', '?');
    begin
      insert into leases (
        org_id, property_id, unit_id, tenant_user_id,
        tenant_name, tenant_phone,
        start_date, end_date, rent_amount, rent_frequency,
        deposit_amount, escalation_pct, notes, status, created_by
      ) values (
        current_user_org_id(),
        (r->>'property_id')::uuid,
        (r->>'unit_id')::uuid,
        nullif(r->>'tenant_user_id', '')::uuid,
        nullif(trim(coalesce(r->>'tenant_name', '')), ''),
        nullif(trim(coalesce(r->>'tenant_phone', '')), ''),
        (r->>'start_date')::date,
        (r->>'end_date')::date,
        (r->>'rent_amount')::numeric,
        coalesce(nullif(r->>'rent_frequency', '')::rent_frequency, 'annual'),
        coalesce(nullif(r->>'deposit_amount', '')::numeric, 0),
        coalesce(nullif(r->>'escalation_pct', '')::numeric, 0),
        nullif(trim(coalesce(r->>'remark', '')), ''),
        -- Always `draft` on insert, then activated below through the one
        -- function that owns that transition. Writing 'active' directly would
        -- bypass `activate_lease` and leave the unit's occupant unset — which
        -- is decision 22's "occupancy and tenancy disagreeing", produced in
        -- bulk.
        'draft',
        auth.uid()
      )
      returning id into v_lease_id;

      v_inserted := v_inserted + 1;
      v_ids := v_ids || v_lease_id;

      if coalesce((r->>'activate')::boolean, false) then
        perform activate_lease(v_lease_id);
        v_activated := v_activated + 1;
      end if;

    exception when others then
      -- ⚠️ Named, and then re-raised. Postgres reports the exclusion
      -- constraint as `leases_no_overlap`, which tells a letting agent
      -- nothing; and without the row number they would be looking for one bad
      -- line in two hundred. Re-raising is deliberate — see the header on why
      -- this is all-or-nothing.
      raise exception 'row %: %', v_row, sqlerrm
        using hint = 'Nothing has been imported. Correct that row and upload the file again.';
    end;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'activated', v_activated,
    'lease_ids', to_jsonb(v_ids)
  );
end;
$fn$;

revoke all on function import_tenancies(jsonb) from public, anon;
grant execute on function import_tenancies(jsonb) to authenticated, service_role;

comment on function import_tenancies is
  'Bulk-records tenancies from the schedule importer (0265). SECURITY INVOKER on purpose: `leases_write` already states the org, the capability and the property scope, and a definer function would be a second copy of that policy. One transaction — a half-imported rent roll cannot be told from a whole one. Rows are inserted as `draft` and activated through activate_lease(), never by writing the status directly, so a unit''s occupant follows its tenancy exactly as it does for a single record.';
