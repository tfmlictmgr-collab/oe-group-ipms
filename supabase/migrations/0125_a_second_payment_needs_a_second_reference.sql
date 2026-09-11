-- A gateway reference must be unique per attempt, not per debt.
--
-- Caught by `verify-tenant-journey` section E, testing that the balance of a
-- part-paid invoice can still be collected. Opening the second checkout failed
-- with `duplicate key value violates unique constraint
-- "payment_intents_org_ref_uidx"`.
--
-- Both intent functions build the reference deterministically from the CHARGE:
--
--     'SC-'   || to_char(now(), 'YYYYMM') || left(service_charge_id, 10)
--     'RENT-' || to_char(period_start, 'YYYYMM') || left(rent_charge_id, 10)
--
-- so every attempt against the same debt produces the same string, and
-- `payment_intents_org_ref_uidx (org_id, gateway_reference)` — correctly —
-- refuses the second one. `0123` removed the index that was blocking a second
-- intent after a part payment; this is the second lock on the same door, and
-- removing only the first fixed nothing.
--
-- ⚠️ This is not confined to the new service-charge path. `create_rent_payment_intent`
-- has carried the same shape since 0092, and there it is worse: no unique index
-- covers `rent_charge_id`, so the function's own `status = 'pending'` guard
-- passes, the insert then fails on the reference, and the tenant is shown a raw
-- duplicate-key error for what is simply "pay the rest of your rent". Fixed
-- here too — it is one line, in two functions, with one cause.
--
-- The prefix and period stay: a reference is read aloud in support calls and
-- quoted in disputes, and 'SC-202608-…' says what it is at a glance. What
-- changes is the tail — the charge id, which repeats, gives way to a random
-- suffix, which does not. The charge is still recoverable from the intent's own
-- `service_charge_id` / `rent_charge_id` column, which is where that link
-- belongs; encoding it in a human-facing string was never what made it findable.

create or replace function create_service_charge_payment_intent(
  p_service_charge_id uuid,
  p_gateway payment_gateway default 'paystack'
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  sc service_charges%rowtype;
  v_unit units%rowtype;
  v_property_id uuid;
  v_id uuid;
  v_ref text;
  v_outstanding numeric(14,2);
begin
  select * into sc from service_charges where id = p_service_charge_id and deleted_at is null;
  if sc.id is null then
    raise exception 'that service charge could not be found';
  end if;
  if auth.uid() is not null and sc.org_id is distinct from current_user_org_id() then
    raise exception 'that invoice belongs to another organisation';
  end if;

  select * into v_unit from units where id = sc.unit_id;
  v_property_id := v_unit.property_id;

  if auth.uid() is not null
     and sc.billed_to_user_id is distinct from auth.uid()
     and not (current_user_role() = any (oversight_roles()))
     and not (v_property_id is not null and v_property_id in (select current_user_property_ids())) then
    raise exception 'that invoice is billed to someone else';
  end if;

  v_outstanding := sc.amount - sc.amount_paid;
  if v_outstanding <= 0 then
    raise exception 'that service charge has already been paid in full';
  end if;

  if exists (
    select 1 from payment_intents
     where service_charge_id = sc.id and status = 'pending'
  ) then
    raise exception 'a payment link is already open for this invoice';
  end if;

  -- Unique per ATTEMPT. The period keeps it readable; the suffix keeps it
  -- collectable a second time.
  v_ref := 'SC-' || to_char(now(), 'YYYYMM') || '-'
        || upper(left(replace(gen_random_uuid()::text, '-', ''), 10));

  insert into payment_intents (
    org_id, purpose, service_charge_id, property_id, unit_id, payer_user_id,
    amount_expected, currency, gateway, gateway_reference, created_by
  ) values (
    sc.org_id, 'service_charge', sc.id, v_property_id, sc.unit_id, sc.billed_to_user_id,
    v_outstanding, 'NGN', p_gateway, v_ref, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function create_service_charge_payment_intent(uuid, payment_gateway) from public;
grant execute on function create_service_charge_payment_intent(uuid, payment_gateway) to authenticated, service_role;

-- Rebuilt from the LIVE definition (`pg_get_functiondef`), not from 0110's
-- file — the only change is `v_ref`. This function has been rewritten from a
-- stale file before (0110 documents the `processing` enum value that 0092's
-- file still contains and the deployment has not had since 0092c), and doing
-- it again would reintroduce a guard that throws instead of guarding.
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

  -- `status = 'pending'`, NOT `in ('pending','processing')` as 0092's own file
  -- still reads: `processing` is not a value of `payment_intent_status`.
  if exists (
    select 1 from payment_intents
     where rent_charge_id = rc.id and status = 'pending'
  ) then
    raise exception 'a payment link is already open for this rent demand';
  end if;

  v_ref := 'RENT-' || to_char(rc.period_start, 'YYYYMM') || '-'
        || upper(left(replace(gen_random_uuid()::text, '-', ''), 10));

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
  'Opens a payment for the outstanding balance of a rent demand. Callable by the demand''s OWN tenant, by oversight roles, or by an FM/PM scoped to the property. One live (pending) intent per demand; the gateway reference is unique per ATTEMPT, so the balance of a part-paid demand can still be collected -- it used to be derived from the charge id and collided with the first attempt.';
