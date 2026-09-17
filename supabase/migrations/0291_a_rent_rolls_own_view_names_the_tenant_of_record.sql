-- 📌 12 Sept 2026. Decision 46's own recorded debt, closed: "rent_roll (Leases
-- & Rent) and the lease page still read only the joined account, so a company
-- let rendered 'Not assigned' there while the schedule named it ... The
-- durable fix is rent_roll coalescing l.tenant_name itself; owed."
--
-- app/dashboard/leases/page.tsx has been working around it since: reading
-- `rent_roll`, finding every account-less row, running a SECOND query against
-- `leases` for `tenant_name`/`tenant_phone`, and merging the two in TypeScript.
-- `tenancy_schedule` (0265) already does this correctly, in the view itself,
-- with `coalesce(t.full_name, l.tenant_name)` — one rule, two consumers, and
-- until now they disagreed about which layer holds it. This makes `rent_roll`
-- match `tenancy_schedule` exactly, so the page's workaround query is deleted
-- rather than kept as a second copy of the same fact.
--
-- `tenant_phone` is appended at the END of the column list, not inlined next
-- to `tenant_email` the way `tenancy_schedule` has it: `create or replace
-- view` refuses to reorder or rename an existing view's columns ("cannot
-- change name of view column ... to ...") and will only let a new column land
-- after every column that already exists.

create or replace view rent_roll
with (security_invoker = on) as
  select
    l.id                as lease_id,
    l.org_id,
    l.property_id,
    p.name              as property_name,
    l.unit_id,
    unit_display_label(u.label, u.description) as unit_label,
    l.tenant_user_id,
    coalesce(t.full_name, l.tenant_name)  as tenant_name,
    t.email             as tenant_email,
    l.status,
    l.start_date,
    l.end_date,
    (l.end_date - current_date)              as days_to_expiry,
    l.rent_amount,
    l.rent_frequency,
    l.escalation_pct,
    l.currency,
    coalesce(c.billed, 0)                    as rent_billed,
    coalesce(c.collected, 0)                 as rent_collected,
    coalesce(c.billed, 0) - coalesce(c.collected, 0) as rent_outstanding,
    coalesce(c.mgmt_fees, 0)                 as management_fees,
    coalesce(c.admin_fees, 0)                as admin_fees,
    coalesce(c.landlord_net, 0)              as landlord_net,
    coalesce(t.phone, l.tenant_phone)        as tenant_phone
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  left join lateral (
    select
      sum(rc.amount)                    as billed,
      sum(rc.amount_paid)               as collected,
      sum(rc.management_fee_amount)     as mgmt_fees,
      sum(rc.admin_fee_amount)          as admin_fees,
      sum(rc.landlord_net_amount)       as landlord_net
    from rent_charges rc
    where rc.lease_id = l.id
  ) c on true
  where l.deleted_at is null
    and (
      current_user_role() = any (oversight_roles())
      or l.property_id in (select current_user_property_ids())
    );

comment on view rent_roll is
  'The tenancy schedule: who is in which unit, until when, for how much, and what has been collected — INCLUDING the fee split, which is why it is offered to oversight and to whoever holds the property, and to nobody else (0229). security_invoker, so leases_select still decides which rows. tenant_name/tenant_phone coalesce the portal account first, then the tenant of record (0265''s pattern, matched here 12 Sept 2026) — a company let or an imported tenancy with no login still names its tenant. A tenant reads my_tenancies() / my_rent_charges() instead; both omit the fee columns. unit_label carries the distinguisher since 0200.';

grant select on rent_roll to authenticated;
