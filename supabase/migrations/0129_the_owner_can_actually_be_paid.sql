-- What is sitting collected and unremitted, per property.
--
-- `create_rent_remittance` has existed since 0092b, was hardened against a
-- double-payout race in 0102, and is exercised by two verification suites. It
-- is called by **nothing else in the codebase** — `grep` across app/ finds it
-- only in scripts/. So rent is demanded on schedule, collected, split, and the
-- landlord's share credited to the segregated ledger, and there is no way for
-- anyone to pay the landlord.
--
-- Same shape as the tenant's rent screen before 0110: the accounting complete,
-- the person at the end of it unable to act.
--
-- What was missing was not the payout — it was knowing what to pay. A finance
-- lead needs the list before they need the button: which properties hold
-- collected rent, whose it is, and whether that landlord can even be paid.

create or replace function landlord_payout_candidates()
returns table (
  property_id uuid,
  property_name text,
  landlord_user_id uuid,
  landlord_name text,
  collected numeric,
  charge_count bigint,
  has_recipient boolean
)
language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.name,
    owner.user_id,
    coalesce(u.full_name, u.email),
    -- ⚠️ What was PAID, apportioned to the landlord's share — never what was
    -- demanded. `create_rent_remittance` totals exactly this expression when
    -- it runs; if this preview used `landlord_net_amount` alone it would show
    -- a figure against a half-paid demand that the payout would then refuse to
    -- match, and finance would be chasing a discrepancy the screen invented.
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)), 0)::numeric,
    count(rc.id),
    exists (
      select 1 from payout_recipients pr
       where pr.org_id = p.org_id
         and pr.party = 'landlord'
         and pr.user_id = owner.user_id
         and pr.active
         and pr.recipient_code is not null
    )
  from properties p
  join property_stakeholders owner
    on owner.property_id = p.id and owner.relation = 'owner'
  join users u on u.id = owner.user_id
  join leases l on l.property_id = p.id and l.deleted_at is null
  join rent_charges rc
    on rc.lease_id = l.id
   and rc.amount_paid > 0        -- collected, not merely demanded
   and rc.remitted_at is null    -- and not already paid out
  -- The whole boundary. This is SECURITY DEFINER — it has to be, because it
  -- reads payout_recipients, which finance alone may see — so this clause is
  -- what stands between a caller and every landlord in the database.
  where p.org_id = current_user_org_id()
    and p.deleted_at is null
    and current_user_role() = any (array['admin','finance_approver','executive']::user_role[])
  group by p.id, p.name, owner.user_id, u.full_name, u.email
  having coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)), 0) > 0
  order by 5 desc;
$$;

revoke all on function landlord_payout_candidates() from public;
revoke execute on function landlord_payout_candidates() from anon;
grant execute on function landlord_payout_candidates() to authenticated;

comment on function landlord_payout_candidates is
  'Properties holding rent that has been COLLECTED and not yet remitted, with the owner, the landlord''s net share of what was actually paid, and whether they have a verified bank recipient. Totals the same expression create_rent_remittance uses, so the preview cannot promise a figure the payout would refuse. Definer-scoped to the caller''s org AND to finance/admin/executive -- an executive may look, and is refused the send in the database.';
