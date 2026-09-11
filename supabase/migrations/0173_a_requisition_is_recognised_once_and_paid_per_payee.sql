-- Disbursing a cleared requisition: recognised once as a liability, paid out
-- once per distinct payee — a vendor named on one or more lines, or a
-- bank-verified one-off/staff payee named on one or more others.
--
-- ⚠️ Two columns ops_requisitions was missing, both because the vendor-payment
-- mirror they are modelled on has them and a requisition needs the same thing:
--   approved_by       — the stage-3 actor, for the same reason
--                        create_vendor_remittance reads pay.approved_by: the
--                        remittance records WHO cleared it, not only when.
--   payable_entry_id  — idempotency for the ledger accrual. A requisition may
--                        be settled by SEVERAL remittances (one per payee),
--                        and the liability must be recognised exactly once,
--                        not once per remittance.

alter table ops_requisitions add column if not exists approved_by uuid references users(id);
alter table ops_requisitions add column if not exists payable_entry_id uuid references ledger_entries(id);
alter table remittances add column if not exists requisition_id uuid references ops_requisitions(id);

comment on column remittances.requisition_id is
  'Which requisition this remittance settles, for reporting — the authoritative claim of WHICH LINES were settled lives on ops_requisition_lines.remittance_id, since one requisition may need several remittances (one per distinct payee).';

-- ── The outcome trigger learns approved_by for a requisition too ─────────
--
-- ⚠️ Rewritten from the LIVE definition, per the 0136 lesson — the only
-- change is `approved_by = new.actor_id` in the ops_requisition branch,
-- mirroring what it already does for vendor_payment.
create or replace function apply_chain_outcome_to_payment()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.payable_type = 'vendor_payment' then
    if new.decision = 'rejected' then
      update payments
         set status          = 'rejected',
             rejected_reason = new.reason,
             rejected_by     = new.actor_id,
             rejected_at     = now()
       where id = new.payable_id
         and status in ('pending_verification', 'verified', 'recommended');
      return new;
    end if;

    if new.stage_order = 3
       and is_cleared_for_disbursement(new.payable_type, new.payable_id, new.amount) then
      update payments
         set status      = 'approved',
             approved_by = new.actor_id,
             approved_at = now()
       where id = new.payable_id
         and status = 'recommended';
    end if;
    return new;
  end if;

  if new.payable_type = 'ops_requisition' then
    if new.decision = 'rejected' then
      update ops_requisitions
         set status          = 'rejected',
             rejected_reason = new.reason,
             rejected_by     = new.actor_id,
             rejected_at     = now()
       where id = new.payable_id
         and status = 'pending_approval';
      return new;
    end if;

    if new.stage_order = 3
       and is_cleared_for_disbursement(new.payable_type, new.payable_id, new.amount) then
      update ops_requisitions
         set status      = 'approved',
             approved_by = new.actor_id,
             approved_at = now()
       where id = new.payable_id
         and status = 'pending_approval';
    end if;
    return new;
  end if;

  return new;
end;
$function$;

-- ── Recognised once, whichever remittance gets there first ────────────────
create or replace function recognise_requisition_payable(p_requisition_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  req ops_requisitions%rowtype;
  v_fund uuid;
  v_payable uuid;
  v_entry uuid;
begin
  select * into req from ops_requisitions where id = p_requisition_id for update;
  if req.id is null then
    raise exception 'requisition not found';
  end if;

  if req.payable_entry_id is not null then
    return req.payable_entry_id;
  end if;

  if req.approved_at is null or req.status <> 'approved' then
    raise exception 'an unapproved requisition is not yet a liability';
  end if;

  v_fund := canonical_ledger_account(req.org_id, 'service_charge_fund');
  v_payable := canonical_ledger_account(req.org_id, 'requisition_payable');
  if v_fund is null or v_payable is null then
    raise exception 'the chart of accounts is not set up for this organisation';
  end if;

  insert into ledger_entries (org_id, entry_date, description, reference, source,
                              entity_type, entity_id, created_by)
  values (
    req.org_id, coalesce(req.approved_at::date, current_date),
    'Requisition approved', req.reference, 'adjustment',
    'ops_requisition', req.id, req.approved_by
  )
  returning id into v_entry;

  insert into ledger_postings (org_id, entry_id, account_id, amount, memo)
  values (req.org_id, v_entry, v_fund,     req.total_amount, 'Committed from the service charge fund'),
         (req.org_id, v_entry, v_payable, -req.total_amount, 'Owed against the requisition');

  update ops_requisitions set payable_entry_id = v_entry where id = req.id;
  return v_entry;
end;
$$;

comment on function recognise_requisition_payable is
  'The accrual: moves the requisition''s total from the service-charge fund into a payable, exactly once, on whichever remittance reaches it first — mirrors recognise_vendor_payable (0169''s account, this migration''s function).';

-- ── Paying a vendor-tagged group of lines ──────────────────────────────────
create or replace function create_requisition_vendor_remittance(
  p_requisition_id uuid,
  p_vendor_id      uuid,
  p_reference      text,
  p_executed_by    uuid
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  req ops_requisitions%rowtype;
  v_recipient uuid;
  v_amount numeric(14,2);
  v_ids uuid[];
  v_id uuid;
  v_claimed int;
begin
  select * into req from ops_requisitions where id = p_requisition_id for update;
  if req.id is null then
    raise exception 'requisition not found';
  end if;
  if req.status <> 'approved' then
    raise exception 'a requisition at status % cannot be remitted', req.status;
  end if;

  -- The chain, at the requisition's CURRENT total — an edit to any line after
  -- approval invalidates the whole chain, same as 0151's amount re-check.
  perform assert_chain_cleared('ops_requisition', req.id, req.total_amount);
  perform assert_may_disburse(p_executed_by, req.org_id);

  -- Maker-checker on EVERY stage of THIS requisition's chain, not only the
  -- final approver — the same widening 0152 applied to vendor payments.
  if exists (
    select 1 from payment_approvals a
     where a.payable_type = 'ops_requisition' and a.payable_id = req.id and a.actor_id = p_executed_by
  ) then
    raise exception 'you approved this requisition at an earlier stage and cannot also send it — someone else must release the money';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = req.org_id and party = 'vendor' and vendor_id = p_vendor_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this vendor';
  end if;

  select array_agg(id order by id) into v_ids
    from (
      select l.id from ops_requisition_lines l
       where l.requisition_id = req.id and l.vendor_id = p_vendor_id and l.remittance_id is null
       order by l.id
       for update
    ) locked;
  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'every line for this vendor on this requisition has already been settled';
  end if;

  select sum(amount) into v_amount from ops_requisition_lines where id = any (v_ids);

  perform recognise_requisition_payable(req.id);

  insert into remittances (
    org_id, party, recipient_id, requisition_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    req.org_id, 'vendor', v_recipient, req.id,
    v_amount, 0, 0, v_amount,
    p_reference, req.approved_by, req.approved_at, p_executed_by
  )
  returning id into v_id;

  update ops_requisition_lines set remittance_id = v_id
   where id = any (v_ids) and remittance_id is null;
  get diagnostics v_claimed = row_count;
  if v_claimed <> array_length(v_ids, 1) then
    raise exception 'these lines were claimed by another action while this one was running; nothing has been sent';
  end if;

  return v_id;
end;
$$;

revoke all on function create_requisition_vendor_remittance(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_requisition_vendor_remittance(uuid, uuid, text, uuid) to service_role;

comment on function create_requisition_vendor_remittance is
  'Settles every not-yet-remitted line on a requisition naming this vendor, in one remittance. Re-checks the chain at the requisition''s current total, the maker-checker against every stage (0152''s widened form), and recognises the accrual exactly once (0173).';

-- ── Paying a one-off / staff payee ─────────────────────────────────────────
create or replace function create_requisition_payee_remittance(
  p_requisition_id     uuid,
  p_payee_recipient_id uuid,
  p_reference          text,
  p_executed_by        uuid
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  req ops_requisitions%rowtype;
  v_recipient payout_recipients%rowtype;
  v_amount numeric(14,2);
  v_ids uuid[];
  v_id uuid;
  v_claimed int;
begin
  select * into req from ops_requisitions where id = p_requisition_id for update;
  if req.id is null then
    raise exception 'requisition not found';
  end if;
  if req.status <> 'approved' then
    raise exception 'a requisition at status % cannot be remitted', req.status;
  end if;

  perform assert_chain_cleared('ops_requisition', req.id, req.total_amount);
  perform assert_may_disburse(p_executed_by, req.org_id);

  if exists (
    select 1 from payment_approvals a
     where a.payable_type = 'ops_requisition' and a.payable_id = req.id and a.actor_id = p_executed_by
  ) then
    raise exception 'you approved this requisition at an earlier stage and cannot also send it — someone else must release the money';
  end if;

  select * into v_recipient from payout_recipients
   where id = p_payee_recipient_id and org_id = req.org_id and party = 'other'
     and active and recipient_code is not null;
  if v_recipient.id is null then
    raise exception 'that payee has no verified bank recipient on file';
  end if;

  select array_agg(id order by id) into v_ids
    from (
      select l.id from ops_requisition_lines l
       where l.requisition_id = req.id and l.payee_recipient_id = p_payee_recipient_id and l.remittance_id is null
       order by l.id
       for update
    ) locked;
  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'every line for this payee on this requisition has already been settled';
  end if;

  select sum(amount) into v_amount from ops_requisition_lines where id = any (v_ids);

  perform recognise_requisition_payable(req.id);

  insert into remittances (
    org_id, party, recipient_id, requisition_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    req.org_id, 'other', v_recipient.id, req.id,
    v_amount, 0, 0, v_amount,
    p_reference, req.approved_by, req.approved_at, p_executed_by
  )
  returning id into v_id;

  update ops_requisition_lines set remittance_id = v_id
   where id = any (v_ids) and remittance_id is null;
  get diagnostics v_claimed = row_count;
  if v_claimed <> array_length(v_ids, 1) then
    raise exception 'these lines were claimed by another action while this one was running; nothing has been sent';
  end if;

  return v_id;
end;
$$;

revoke all on function create_requisition_payee_remittance(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function create_requisition_payee_remittance(uuid, uuid, text, uuid) to service_role;

comment on function create_requisition_payee_remittance is
  'Settles every not-yet-remitted line on a requisition naming this verified one-off/staff payee, in one remittance. Same gates as create_requisition_vendor_remittance (0173).';
