-- A co-owned property says so, on the screen where it matters.
--
-- `0232` made ownership deterministic, and in doing so it made a second owner
-- **consistently invisible** where they had been **randomly double-counted**.
-- That is the right trade — an arbitrary answer is worse than a fixed one — but
-- it is not free, and leaving it silent would be the same fault in a new place:
-- a screen that reports a fact confidently while omitting the thing that
-- qualifies it.
--
-- Measured on staging: **3 properties carry more than one `owner` stakeholder**.
-- Under `0091`/`0181` each one's snapshotted management-fee rate was whichever
-- owner the planner reached first; under `0232` it is the first owner recorded.
-- Neither is a *split*. The money still goes to one person, and the other
-- co-owner's claim on it is settled outside this system.
--
-- So the payout list now reports `co_owner_count`. Finance sees "2 owners on
-- file, paying X" rather than "paying X", and can stop and ask before releasing
-- money against a building whose ownership the schema cannot express. That is
-- the whole intervention: **disclosure, not derivation** — the same line `0076`
-- drew refusing to derive intake with no override, and decision 22 drew again
-- refusing to vacate a unit from a date.
--
-- ⚠️ Deliberately NOT a constraint. A unique partial index on
-- `(property_id) where relation = 'owner'` would state the rule the code now
-- assumes — and would fail to apply against three live properties, or, worse,
-- would be applied by deleting two people's recorded interest in a building to
-- make a migration pass. Representing genuine co-ownership needs a board
-- decision (a share column, and a remittance that splits against it); until
-- then the honest position is that the system holds one payee and admits it.

-- ⚠️ Dropped first: adding an OUT column changes the function's return type,
-- which `create or replace` refuses ("Row type defined by OUT parameters is
-- different"). The drop takes the grants with it, which is why the revoke and
-- grant below are re-stated rather than assumed -- a drop-and-create re-opens
-- what a previous migration closed, the fault decision 25 records against
-- exactly this pattern.
drop function if exists landlord_payout_candidates();

create or replace function landlord_payout_candidates()
returns table (
  property_id uuid,
  property_name text,
  landlord_user_id uuid,
  landlord_name text,
  collected numeric,
  charge_count bigint,
  has_recipient boolean,
  co_owner_count bigint
)
language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.name,
    u.id,
    coalesce(u.full_name, u.email),
    coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0)::numeric,
    count(rc.id),
    exists (
      select 1 from payout_recipients pr
       where pr.org_id = p.org_id
         and pr.party = 'landlord'
         and pr.user_id = u.id
         and pr.active
         and pr.recipient_code is not null
    ),
    -- How many people are recorded as owning this building. One is ordinary;
    -- more than one means the figure beside it is going to ONE of them.
    (select count(*) from property_stakeholders s
      where s.property_id = p.id and s.relation = 'owner')
  from properties p
  join users u on u.id = property_landlord(p.id)
  join leases l on l.property_id = p.id and l.deleted_at is null
  join rent_charges rc
    on rc.lease_id = l.id
   and rc.amount_paid > 0
   and rc.remitted_at is null
  where p.org_id = current_user_org_id()
    and p.deleted_at is null
    and current_user_role() = any (array['admin','finance_approver','executive']::user_role[])
  group by p.id, p.name, u.id, u.full_name, u.email
  having coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) > 0
  order by 5 desc;
$$;

revoke all on function landlord_payout_candidates() from public;
revoke execute on function landlord_payout_candidates() from anon;
grant execute on function landlord_payout_candidates() to authenticated;

comment on function landlord_payout_candidates is
  'Properties holding rent that has been COLLECTED and not yet remitted, with the owner of record, the landlord''s net share of what was actually paid, whether they have a verified bank recipient, and how many owners are on file. One row per property (0232); co_owner_count above 1 means the whole figure is going to one of several recorded owners, which the schema cannot split and this column therefore states (0235). Totals the same expression create_rent_remittance uses. Definer-scoped to the caller''s org AND to finance/admin/executive -- an executive may look, and is refused the send in the database.';
