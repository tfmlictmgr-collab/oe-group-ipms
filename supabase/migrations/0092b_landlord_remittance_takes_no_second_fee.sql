-- Remitting rent pays out a balance that is already net.
--
-- ⚠️ `create_landlord_remittance` (0041) computes its own fees from
-- `payment_settings.management_fee_percent`. For rent that came through a
-- `rent_charge`, the fee has ALREADY been taken at collection (0092) from the
-- rate snapshotted on the demand — so remitting through that function would
-- deduct it a second time and short the landlord by the fee twice over.
--
-- The two paths are now distinct rather than one path with a flag:
--
--   • `create_landlord_remittance` — unchanged, for rent recorded outside the
--     rent_charges model (a manual receipt, a legacy balance). It still applies
--     the payment_settings percentages, which is correct when nothing has been
--     deducted yet.
--   • `create_rent_remittance` — for money collected against rent demands. It
--     sums the SNAPSHOTTED landlord net of charges actually paid, deducts
--     nothing, and marks those charges remitted so the same month cannot be
--     paid out twice.
--
-- 📌 `payment_settings.management_fee_percent` and `orgs.management_fee_pct`
-- (decision 14) now govern different paths, and that is a seam worth closing:
-- the settings screen should eventually write one number. Flagged rather than
-- silently reconciled, because merging them changes what an existing manual
-- remittance would deduct.

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

  -- Only what has actually been COLLECTED and not yet paid out. Remitting
  -- against a demand that is merely raised would pay a landlord money no tenant
  -- has handed over.
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
    org_id, party, user_id, recipient_id, period, reference,
    gross_amount, management_fee, admin_fee, net_amount, status, created_by
  ) values (
    p_org_id, 'landlord', p_landlord_user_id, v_recipient, p_period,
    'RENT-REM-' || to_char(now(), 'YYYYMMDD') || '-' || left(replace(p_property_id::text, '-', ''), 6),
    -- Gross IS net here: the fee was taken at collection and is already sitting
    -- in fee_income. Reporting a fee again would double-count it in every
    -- statement that sums remittance fees.
    v_net, 0, 0, v_net, 'pending', auth.uid()
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

-- Nothing may be remitted twice: one remittance per charge, enforced.
create unique index if not exists rent_charges_remittance_uidx
  on rent_charges (id) where remitted_at is not null;

comment on column rent_charges.remitted_at is
  'When this charge''s collected net was paid out to the landlord. Set once — the guard against paying the same month twice.';
