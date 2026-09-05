-- The tenancy schedule is generated, not typed (decision 31/Part B, 5 Sept 2026).
--
-- Built against `private/MANAGEMENT PORTFOLIO.xlsx`, the workbook OEA actually
-- keeps this portfolio in. Eighteen sheets, thirteen of them a property ledger:
-- a header block naming the LANDLORD, the PROPERTY ADDRESS and the PROPERTY
-- DESCRIPTION, then a table of tenancies with a consistent set of columns —
--
--     S/N · NAME OF TENANT · PHONE NUMBER · TENANCY PERIOD · RENT P/A ·
--     SERVICE CHARGE · AMOUNT PAID · SIZE / SHOP NO. / FLOOR ·
--     MGT FEE @ n% · OUTSTANDING · REMARK
--
-- Every one of those is already in this database, spread across six tables and
-- reachable from no single screen. That is the whole reason the spreadsheet
-- still exists: not because the data is missing, but because nothing assembles
-- it. So this view assembles it, and the sheet becomes a report rather than a
-- second set of books that can disagree with the first.
--
-- Three things the workbook does that this deliberately reproduces:
--
--   • The management fee PERCENTAGE VARIES PER PROPERTY — 5%, 7%, 7.5% and 10%
--     all appear, one rate per landlord block. That is decision 14's
--     org-default-plus-landlord-override, and it is read here from the rate
--     SNAPSHOTTED ONTO THE CHARGE at collection time, never from the org's
--     current setting. A later rate change must not silently rewrite a past
--     schedule, which is the same rule decision 14 states for a statement.
--
--   • "Paid and remitted" vs "paid and not yet remitted" is a distinction the
--     REMARK column carries by hand in the workbook, and it is the difference
--     between money collected and money passed to the landlord. Here it is
--     `rent_collected` against `landlord_net`, which the ledger already knows.
--
--   • Rent and service charge sit SIDE BY SIDE and are never added. Decision 25
--     is explicit: rent is collected FOR the owner and remitted net of fees,
--     service charge INTO a fund the building spends. A combined total would be
--     the 0103 cross-currency mistake with a friendlier label.
--
-- ⚠️ AUDIENCE, stated (decision 25). `security_invoker` means RLS applies, and
-- `leases_select` admits a TENANT to their own row — so without the predicate
-- below a tenant reaching this view would be shown their own tenancy under a
-- column headed "Landlord net", which is exactly the exposure 0229 had to close
-- on `rent_roll`. The same predicate `rent_roll` carries is therefore carried
-- here, and a tenant is refused rather than served zeroes: a zero that means
-- "you may not see this" is indistinguishable from one that means "nothing was
-- billed".
create or replace view tenancy_schedule
with (security_invoker = on) as
select
  l.id                       as lease_id,
  l.org_id,
  l.created_at               as recorded_at,

  -- The landlord block
  l.property_id,
  p.name                     as property_name,
  p.address                  as property_address,
  p.property_type,
  own.user_id                as owner_user_id,
  ownu.full_name             as owner_name,
  ownu.email                 as owner_email,

  -- The unit: the workbook's SIZE / SHOP NO. / FLOOR column
  l.unit_id,
  unit_display_label(u.label, u.description) as unit_label,
  u.apportionment_factor     as unit_space,

  -- The tenant
  l.tenant_user_id,
  t.full_name                as tenant_name,
  t.email                    as tenant_email,
  t.phone                    as tenant_phone,

  -- TENANCY PERIOD
  l.status,
  l.start_date,
  l.end_date,
  l.end_date - current_date  as days_to_expiry,

  -- RENT P/A and what has come in against it
  l.rent_amount,
  l.rent_frequency,
  l.currency,
  l.escalation_pct,
  coalesce(c.billed, 0)      as rent_billed,
  coalesce(c.collected, 0)   as rent_collected,
  coalesce(c.billed, 0) - coalesce(c.collected, 0) as rent_outstanding,

  -- MGT FEE @ n%, at the rate that actually applied
  c.fee_pct                  as management_fee_pct,
  coalesce(c.mgmt_fees, 0)   as management_fees,
  coalesce(c.admin_fees, 0)  as admin_fees,
  coalesce(c.landlord_net, 0) as landlord_net,

  -- SERVICE CHARGE — reported beside the rent and never added to it
  coalesce(sc.sc_billed, 0)     as service_charge_billed,
  coalesce(sc.sc_collected, 0)  as service_charge_collected,
  coalesce(sc.sc_billed, 0) - coalesce(sc.sc_collected, 0) as service_charge_outstanding,

  -- REMARK
  l.notes                    as remark
from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  -- The owner of record. `distinct on` because a property may carry more than
  -- one owner stakeholder row (0235 records co-ownership); the schedule names
  -- one, deterministically, and the property's own page remains the place a
  -- co-owned title is read in full.
  left join lateral (
    select s.user_id
      from property_stakeholders s
     where s.property_id = l.property_id and s.relation = 'owner'
     order by s.created_at, s.user_id
     limit 1
  ) own on true
  left join users ownu on ownu.id = own.user_id
  left join lateral (
    select sum(rc.amount)                  as billed,
           sum(rc.amount_paid)             as collected,
           sum(rc.management_fee_amount)   as mgmt_fees,
           sum(rc.admin_fee_amount)        as admin_fees,
           sum(rc.landlord_net_amount)     as landlord_net,
           max(rc.management_fee_pct)      as fee_pct
      from rent_charges rc
     where rc.lease_id = l.id
  ) c on true
  -- Service charge is raised against a UNIT, not a tenancy, so it is matched on
  -- the unit and bounded to this tenancy's own term. A charge raised on the
  -- same flat for last year's tenant is that tenant's, not this one's.
  left join lateral (
    select sum(s.amount)      as sc_billed,
           sum(s.amount_paid) as sc_collected
      from service_charges s
     where s.unit_id = l.unit_id
       and s.deleted_at is null
       and s.created_at >= l.start_date
       and s.created_at < (l.end_date + 1)
  ) sc on true
where l.deleted_at is null
  and (
    current_user_role() = any (oversight_roles())
    or l.property_id in (select current_user_property_ids())
  );

comment on view tenancy_schedule is
  'One row per tenancy, carrying every column the MANAGEMENT PORTFOLIO workbook keeps by hand — landlord, address, unit, tenant, term, rent, service charge, fee at the rate that applied, and the remark (0254).';

-- ⚠️ `security_invoker` does not revoke anything by itself. The predicate above
-- states the audience; this states who may reach the object at all. `anon` is
-- named explicitly because a `create or replace view` re-applies Supabase's
-- defaults, which is the same fault 0204/0209/0210/0214 keep recording for
-- functions and 0229 met on a view.
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
