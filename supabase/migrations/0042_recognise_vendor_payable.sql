-- The obligation to a vendor was never in the books.
--
-- `payments` tracked an invoice through verify → score → approve → remit, but
-- none of that touched the ledger. So remittance tried to settle a liability
-- that had never been recognised, and the overpayment guard in 0027 correctly
-- refused it:
--
--     account 2200 would be overpaid by 180000.00 — a counterparty cannot be
--     paid more than is owed to them.
--
-- The guard was right and the books were wrong. Approving an invoice IS the
-- moment the obligation arises, and that is when it should be posted.
--
-- Beyond correctness, this is what makes "vendor liabilities" a real figure
-- rather than a count of rows in another table — the B2 Module 6 dashboard is
-- specified to report it, and an executive reading it should be reading the
-- ledger.
--
--   Dr  service charge fund   (we hold less on the fund's behalf)
--   Cr  vendor payable        (we now owe the vendor)
--
-- Debiting the SC fund is the arrangement in B2/B4: vendor costs are met from
-- the service charge collected for the property. It also means the fund cannot
-- be committed beyond what was actually collected — the same guard then refuses
-- an approval the fund cannot cover, which is a control, not an obstacle.

alter table payments add column if not exists payable_entry_id uuid references ledger_entries(id);

comment on column payments.payable_entry_id is
  'The ledger entry recognising this invoice as a liability. Its presence IS the "already recognised" flag — no separate boolean to drift.';

create or replace function recognise_vendor_payable(p_payment_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pay payments%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into pay from payments where id = p_payment_id for update;
  if pay.id is null then
    raise exception 'payment not found';
  end if;

  -- Idempotent: calling it again returns what already exists. Both the approval
  -- action and remittance creation call this, so it must be safe twice.
  if pay.payable_entry_id is not null then
    return pay.payable_entry_id;
  end if;

  -- Only an approved invoice is an obligation. Anything earlier is a claim.
  if pay.approved_at is null or pay.status not in ('approved', 'remitted') then
    raise exception 'an unapproved payment is not yet a liability';
  end if;

  select id into v_fund from ledger_accounts
   where org_id = pay.org_id and purpose = 'service_charge_fund' and active
   order by created_at, id limit 1;
  select id into v_payable from ledger_accounts
   where org_id = pay.org_id and purpose = 'vendor_payable' and active
   order by created_at, id limit 1;

  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    pay.org_id, coalesce(pay.approved_at::date, current_date),
    'Vendor invoice approved', pay.invoice_reference, 'adjustment',
    'payment', pay.id, pay.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (pay.org_id, v_entry, v_fund, pay.amount, 'Committed from the service charge fund'),
         (pay.org_id, v_entry, v_payable, -pay.amount, 'Owed to the vendor');

  update payments set payable_entry_id = v_entry where id = pay.id;
  return v_entry;
end;
$$;

-- Recognise the liability when the remittance is raised, for any invoice
-- approved before this migration existed. Idempotent, so an invoice approved
-- through the normal path — which recognises it at approval — is unaffected.
create or replace function create_vendor_remittance(
  p_payment_id uuid,
  p_reference text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  pay payments%rowtype;
  v_recipient uuid;
  v_id uuid;
begin
  select * into pay from payments where id = p_payment_id for update;
  if pay.id is null then
    raise exception 'payment not found';
  end if;

  if pay.service_verified_at is null then
    raise exception 'the service on this payment has not been verified';
  end if;
  if not pay.performance_validated then
    raise exception 'the vendor did not pass the performance check';
  end if;
  if pay.approved_at is null or pay.approved_by is null then
    raise exception 'this payment has not been approved';
  end if;
  if pay.status <> 'approved' then
    raise exception 'a payment at status % cannot be remitted', pay.status;
  end if;

  select id into v_recipient from payout_recipients
   where org_id = pay.org_id and party = 'vendor' and vendor_id = pay.vendor_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this vendor';
  end if;

  -- The obligation must exist in the ledger before it can be settled.
  perform recognise_vendor_payable(pay.id);

  insert into remittances (
    org_id, party, recipient_id, payment_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    pay.org_id, 'vendor', v_recipient, pay.id,
    pay.amount, 0, 0, pay.amount,
    p_reference, pay.approved_by, pay.approved_at, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function recognise_vendor_payable(uuid) from public;
grant execute on function recognise_vendor_payable(uuid) to service_role;
