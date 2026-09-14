-- `create_rent_remittance` wrote columns `remittances` does not have.
--
-- ⚠️ It set `user_id` and `status = 'pending'`. The table identifies the
-- landlord through `recipient_id` → `payout_recipients.user_id` — deliberately,
-- so a remittance always points at a VERIFIED bank recipient rather than at a
-- person who may have none — and the status enum opens at `'queued'`, not
-- `'pending'`.
--
-- 📌 Same fault as `0092c`, one migration apart: I wrote plausible column and
-- enum names from memory instead of reading the table. Both applied cleanly and
-- both failed only when executed, because a plpgsql body is not resolved until
-- it runs. Reading the DDL takes ten seconds; this took two rounds of a suite.
create or replace function create_rent_remittance(
  p_org_id uuid,
  p_landlord_user_id uuid,
  p_property_id uuid,
  p_period text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
  v_net numeric(16,2);
  v_ids uuid[];
  v_id uuid;
begin
  if auth.uid() is not null and not has_permission('remittance.execute') then
    raise exception 'you do not have permission to remit funds';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = p_org_id and party = 'landlord' and user_id = p_landlord_user_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;

  -- Only what has been COLLECTED and not yet paid out. Remitting against a
  -- demand that is merely raised would pay a landlord money no tenant has
  -- handed over.
  select coalesce(sum(
           round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)
         ), 0),
         array_agg(rc.id)
    into v_net, v_ids
    from rent_charges rc
    join leases l on l.id = rc.lease_id
   where rc.org_id = p_org_id
     and l.property_id = p_property_id
     and rc.amount_paid > 0
     and rc.remitted_at is null;

  if v_net is null or v_net <= 0 then
    raise exception 'there is no collected rent awaiting remittance for this property';
  end if;

  insert into remittances (
    org_id, party, recipient_id, property_id, period, reference,
    gross_amount, management_fee, admin_fee, net_amount, status, created_by
  ) values (
    p_org_id, 'landlord', v_recipient, p_property_id, p_period,
    'RENT-REM-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || left(replace(p_property_id::text, '-', ''), 6),
    -- Gross IS net: the fee was taken at collection and already sits in
    -- fee_income. Reporting a fee here again would double-count it in every
    -- statement that sums remittance fees, and the table's own
    -- `net = gross - fees` check would then describe a deduction nobody made.
    v_net, 0, 0, v_net, 'queued', auth.uid()
  )
  returning id into v_id;

  update rent_charges
     set remitted_at = now(), remittance_id = v_id
   where id = any (v_ids);

  return v_id;
end;
$$;

revoke all on function create_rent_remittance(uuid, uuid, uuid, text) from public;
grant execute on function create_rent_remittance(uuid, uuid, uuid, text) to authenticated, service_role;

comment on function create_rent_remittance is
  'Remits collected rent to a landlord. Pays out the SNAPSHOTTED net of charges already collected and deducts nothing — the fee was taken at collection (0092), and deducting again would short the landlord twice.';
