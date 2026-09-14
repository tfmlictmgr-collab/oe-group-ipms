-- The tenant-facing half of Day 9 (gap found by PC2, 2026-08-06).
--
-- Day 9 built lease admin, rent billing, the rent roll, renewal notices, and
-- the ledger split that takes OE Group's fee and credits the landlord — all
-- verified. What it never built was a way for the person who owes the rent to
-- see it or pay it. `my_tenancies()` was written for exactly that view and is
-- called nowhere; `rent_charges` is queried only from admin routes. So the
-- accounting is fully wired to receive a rent payment that a tenant has no
-- way to make.
--
-- ⚠️ Before adding that screen, a real defect in the function it must call.
--
-- `create_rent_payment_intent` (0092) is SECURITY DEFINER — so its own SELECT
-- of `rent_charges` bypasses RLS — is granted to `authenticated`, and checks
-- only that the demand belongs to the caller's ORGANISATION. It never checks
-- that the caller is the tenant on the lease. Any authenticated member of the
-- org (another tenant, a vendor, ops staff) could therefore open a payment
-- link against somebody else's rent.
--
-- The sharper consequence is not the payment — paying a stranger's rent is a
-- strange attack — it is the function's OWN one-live-intent guard, three lines
-- further down: "a payment link is already open for this rent demand". Opening
-- an intent on another tenant's demand LOCKS THAT TENANT OUT of paying their
-- own rent, and nothing in the app would explain why. A denial-of-service on
-- someone else's obligation, from any account in the org.
--
-- Fixed by naming who may open a demand: the tenant it belongs to, or staff
-- who legitimately raise a link on a tenant's behalf. The org check stays as
-- the outer boundary; this is the inner one it never had.
create or replace function create_rent_payment_intent(
  p_rent_charge_id uuid,
  p_gateway payment_gateway default 'paystack'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  rc rent_charges%rowtype;
  l  leases%rowtype;
  v_id uuid;
  v_ref text;
  v_outstanding numeric(16,2);
begin
  select * into rc from rent_charges where id = p_rent_charge_id;
  if rc.id is null then
    raise exception 'that rent demand could not be found';
  end if;
  if auth.uid() is not null and rc.org_id is distinct from current_user_org_id() then
    raise exception 'that demand belongs to another organisation';
  end if;

  select * into l from leases where id = rc.lease_id;

  -- The check this function never had. Skipped entirely for a service-role
  -- caller (auth.uid() is null) — the scheduled demand job has no session and
  -- is trusted by definition.
  if auth.uid() is not null
     and l.tenant_user_id is distinct from auth.uid()
     and not (current_user_role() = any (oversight_roles()))
     and not (l.property_id in (select current_user_property_ids())) then
    raise exception 'that rent demand belongs to another tenant';
  end if;

  v_outstanding := rc.amount - rc.amount_paid;
  if v_outstanding <= 0 then
    raise exception 'that rent has already been paid in full';
  end if;

  -- One live intent per demand, mirroring 0045's rule for invoices: two open
  -- checkout links for one debt is how a tenant pays twice.
  --
  -- ⚠️ `status = 'pending'`, NOT `in ('pending','processing')` as 0092's own
  -- file still reads. `processing` is not a value of `payment_intent_status`
  -- and 0092c replaced this function to say so; the migration FILE was never
  -- corrected, so anyone rewriting this function from the file — as this one
  -- nearly did — reintroduces a guard that throws `invalid input value for
  -- enum` instead of guarding anything. Copied from the LIVE definition
  -- (`pg_proc.prosrc`), not from 0092.
  if exists (
    select 1 from payment_intents
     where rent_charge_id = rc.id and status = 'pending'
  ) then
    raise exception 'a payment link is already open for this rent demand';
  end if;

  v_ref := 'RENT-' || to_char(rc.period_start, 'YYYYMM') || '-' || left(replace(rc.id::text, '-', ''), 10);

  insert into payment_intents (
    org_id, purpose, rent_charge_id, property_id, unit_id, payer_user_id,
    amount_expected, currency, gateway, gateway_reference, created_by
  ) values (
    rc.org_id, 'rent', rc.id, l.property_id, l.unit_id, l.tenant_user_id,
    v_outstanding, rc.currency, p_gateway, v_ref, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function create_rent_payment_intent(uuid, payment_gateway) from public;
grant execute on function create_rent_payment_intent(uuid, payment_gateway) to authenticated, service_role;

comment on function create_rent_payment_intent is
  'Opens a payment for the outstanding balance of a rent demand. Callable by the demand''s OWN tenant, by oversight roles, or by an FM/PM scoped to the property -- never by an unrelated member of the org, who could otherwise lock the real tenant out via the one-live-intent guard below. One live intent per demand: two open checkout links for one debt is how a tenant pays twice.';

-- ── What the tenant's own screen reads ────────────────────────────────────
--
-- `rent_charges_select` (0090) already admits the lease's tenant, so the page
-- could query the table directly. It does not, for the same reason
-- `my_tenancies()` exists: a tenant has no read on `properties` or `units`, so
-- a direct query cannot name the flat the charge is for — it would show a row
-- of money against a UUID. This denormalises the labels the same definer-scoped
-- way, and carries the live intent's reference so the screen can link straight
-- to a checkout already open rather than trying to raise a second one.
create or replace function my_rent_charges()
returns table (
  charge_id uuid,
  lease_id uuid,
  property_name text,
  unit_label text,
  period_start date,
  period_end date,
  due_date date,
  amount numeric,
  amount_paid numeric,
  outstanding numeric,
  currency text,
  status text,
  open_intent_reference text
)
language sql stable security definer set search_path = public as $$
  select
    rc.id, rc.lease_id, p.name, u.label,
    rc.period_start, rc.period_end, rc.due_date,
    rc.amount, rc.amount_paid,
    rc.amount - rc.amount_paid,
    rc.currency, rc.status::text,
    -- `pending` only, matching the live guard in create_rent_payment_intent
    -- above — a `part_paid` intent is not a link waiting to be followed.
    (select pi.gateway_reference
       from payment_intents pi
      where pi.rent_charge_id = rc.id
        and pi.status = 'pending'
      order by pi.created_at desc
      limit 1)
  from rent_charges rc
  join leases l     on l.id = rc.lease_id
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  -- The whole boundary, in one line — the same shape `my_tenancies()` uses,
  -- and for the same reason: this is SECURITY DEFINER, so this WHERE clause is
  -- all that stands between a caller and every rent charge in the database.
  where l.tenant_user_id = auth.uid()
    and l.deleted_at is null
  order by rc.period_start desc;
$$;

revoke all on function my_rent_charges() from public;
grant execute on function my_rent_charges() to authenticated;

comment on function my_rent_charges is
  'The caller''s own rent demands, with property/unit labels denormalised and any live checkout reference attached. Definer-scoped to auth.uid() because a tenant has no read on the property register -- and should not need one to see what they owe on their own flat.';
