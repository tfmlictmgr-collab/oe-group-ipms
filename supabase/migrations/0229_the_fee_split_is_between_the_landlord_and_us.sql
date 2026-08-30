-- What a landlord is charged is between the landlord and OE Group, and a
-- tenant could read it.
--
-- 0226 gated the fee columns on the tenancy detail page and RECORDED the fact
-- underneath as unfixed: `rent_charges_select` (0090) admits the lease's own
-- tenant, RLS is row-level, and so a tenant retained a direct SELECT on
-- `management_fee_pct`, `management_fee_amount` and `landlord_net_amount` for
-- their own charges. That note said the exposure was "not reachable on any
-- screen". ⚠️ **That was wrong, and measuring it is what showed it.**
--
-- Signed in as the live OEA tenant through PostgREST:
--
--   • `rent_charges`  → 24 rows, management_fee_pct 10, management_fee_amount
--                       ₦600,000, landlord_net_amount ₦5,400,000
--   • `rent_roll`     → 18 rows, 15 of them carrying a non-zero
--                       `management_fees` / `landlord_net`
--
-- The second is the one that matters. `rent_roll` is `security_invoker`, so its
-- lateral over `rent_charges` runs under the reader — and it publishes the sums
-- as columns NAMED `management_fees` and `landlord_net`. `/dashboard/leases`
-- carries no role guard of its own (it gates the module and the write buttons,
-- never the read), so a tenant who types that URL is rendered their own tenancy
-- with a column headed **"Landlord net"**. Not a theoretical API reach: a
-- screen, with a heading.
--
-- 📌 The lesson is the narrower one. The exposure was recorded honestly and the
-- reachability was asserted from READING the code. A column list on a view two
-- files away turned "unreachable" into "rendered". **A claim that something is
-- unreachable is a measurement, not a reading** — and the probe took a minute.
--
-- ── The fix is not column privileges ──────────────────────────────────────
--
-- The note proposed column privileges or a new view "across four consumers".
-- Both are wrong. Column privileges are granted per ROLE, and every signed-in
-- person here is `authenticated` — revoking the fee columns from that role
-- takes them from the payment officer and the landlord too. And the view
-- already exists: `my_rent_charges()` (0110) is SECURITY DEFINER, scoped to
-- `l.tenant_user_id = auth.uid()`, and returns exactly the tenant-safe column
-- set — amount, paid, outstanding, due date, status, currency, the open
-- reference. It was written for the tenant's own rent screen and has never
-- returned a fee column.
--
-- So the tenant already had a resolver. What they also had was a second way in,
-- and the second way was the wrong one. This removes it — decision 8's "one
-- resolver, extended", applied by DELETING the duplicate rather than adding a
-- third thing.
--
--   1. `rent_charges_select` drops its tenant branch, leaving oversight and
--      whoever holds the property. Both of those legitimately read the fee
--      split: it is the landlord's own statement line and finance's own margin.
--   2. `rent_roll` states the same two audiences in its own WHERE clause.
--
-- (2) is not belt-and-braces, and leaving it out would be worse than doing
-- nothing. With only (1), a tenant querying `rent_roll` still matches on
-- `leases_select` and still gets their row — but the lateral now finds no
-- `rent_charges`, so `coalesce(..., 0)` reports **management_fees 0,
-- landlord_net 0, rent_billed 0** on a tenancy that has been billed
-- ₦6,000,000. A refusal is honest; a zero is a lie the reader cannot tell from
-- a fact. The view says who it is for instead.
--
-- ⚠️ Nothing here narrows `current_user_property_ids()`, which answers for an
-- `owner` exactly as for a `manager` (0184's whole point) — a landlord keeps
-- their rent roll and their fee lines. And no definer function changes:
-- `my_tenancies()`, `my_rent_charges()`, `landlord_statement()` and
-- `property_statement()` read `rent_charges` with RLS bypassed, so the tenant's
-- own screens, the owner's portfolio and the property statement are untouched.

-- ── 1. The tenant branch leaves the policy ────────────────────────────────

drop policy if exists rent_charges_select on rent_charges;

create policy rent_charges_select on rent_charges for select to authenticated
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from leases l
       where l.id = rent_charges.lease_id
         and (
           -- ⚠️ `l.tenant_user_id = auth.uid()` was here and is deliberately
           -- gone. A tenant reads their own rent through `my_rent_charges()`,
           -- which returns no fee column. Restoring this line restores the
           -- exposure — it is the whole of 0229.
           current_user_role() = any (oversight_roles())
           or l.property_id in (select current_user_property_ids())
         )
    )
  );

comment on policy rent_charges_select on rent_charges is
  'Oversight, and whoever holds the property. NOT the tenant: a rent charge carries the management and admin fee and the landlord net, which are between the landlord and OE Group. The tenant reads their own charges through my_rent_charges() (0110), which returns amount, paid and outstanding and no fee column. See 0229.';

-- ── 2. The rent roll says who it is for ───────────────────────────────────

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
    t.full_name         as tenant_name,
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
    coalesce(c.landlord_net, 0)              as landlord_net
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  left join lateral (
    select
      sum(rc.amount)                as billed,
      sum(rc.amount_paid)           as collected,
      sum(rc.management_fee_amount) as mgmt_fees,
      sum(rc.admin_fee_amount)      as admin_fees,
      sum(rc.landlord_net_amount)   as landlord_net
    from rent_charges rc
    where rc.lease_id = l.id
  ) c on true
  where l.deleted_at is null
    -- ⚠️ NEW (0229). Not a second scoping rule: `leases_select` still decides
    -- WHICH leases, and this decides WHO is handed a rent roll at all. Without
    -- it a tenant is handed their own row with every money column silently
    -- coalesced to zero, because the lateral can no longer read the charges —
    -- and a zero that means "you may not see this" is indistinguishable from a
    -- zero that means "nothing has been billed".
    and (
      current_user_role() = any (oversight_roles())
      or l.property_id in (select current_user_property_ids())
    );

comment on view rent_roll is
  'The tenancy schedule: who is in which unit, until when, for how much, and what has been collected — INCLUDING the fee split, which is why it is offered to oversight and to whoever holds the property, and to nobody else (0229). security_invoker, so leases_select still decides which rows. A tenant reads my_tenancies() / my_rent_charges() instead; both omit the fee columns. unit_label carries the distinguisher since 0200.';

grant select on rent_roll to authenticated;
