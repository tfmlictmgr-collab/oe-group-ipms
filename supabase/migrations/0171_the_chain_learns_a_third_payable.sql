-- `payment_approvals`, `resolve_payable()` and the chain's outcome trigger
-- learn `ops_requisition` — the third payable type, after `vendor_payment`
-- and `landlord_payout`. Nothing about the CHAIN ITSELF changes: same three
-- stages, same tier ladder, same separation-of-duties, same amount
-- re-resolution at every step. This is the whole of decision 8's "one
-- resolver, extended" applied a second time.
--
-- ⚠️ Both functions rewritten from the LIVE definitions (`pg_get_functiondef`),
-- per the 0136 lesson.

alter table payment_approvals drop constraint if exists payment_approvals_payable_type_check;
alter table payment_approvals add constraint payment_approvals_payable_type_check
  check (payable_type = any (array['vendor_payment', 'landlord_payout', 'ops_requisition']));

create or replace function resolve_payable(p_type text, p_id uuid)
returns table (org_id uuid, amount numeric)
language plpgsql stable security definer set search_path to 'public' as $function$
begin
  if p_type = 'vendor_payment' then
    return query select p.org_id, p.amount from payments p where p.id = p_id;
  elsif p_type = 'landlord_payout' then
    return query select r.org_id, r.net_amount from remittances r where r.id = p_id;
  elsif p_type = 'ops_requisition' then
    return query select q.org_id, q.total_amount from ops_requisitions q where q.id = p_id;
  else
    raise exception 'unknown payable type %', p_type;
  end if;
end;
$function$;

comment on function resolve_payable is
  'The org and amount of a payable, read from its own record -- the single place the chain learns what is being paid, so a client-supplied amount never reaches the tier comparison. Three payable types since 0171: vendor_payment, landlord_payout, ops_requisition.';

-- ── The outcome trigger, extended ──────────────────────────────────────────
--
-- ⚠️ `ops_requisition` goes straight from `pending_approval` to `approved` on
-- stage 3, with NO intermediate `recommended` state to pass through first.
-- That sidesteps a latent edge case in the vendor path worth naming rather
-- than silently working around: `apply_chain_outcome_to_payment`'s vendor
-- branch only flips status when it is ALREADY `recommended` at the moment
-- stage 3 clears — if the three chain stages are recorded before service
-- verification finishes, the payment can sit fully chain-cleared and still
-- never reach `approved`, because nothing re-checks the chain once
-- verification later lands. That gap predates this migration and is not
-- fixed here; it is out of scope of a requisition, which has no verification
-- step to race against.
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
             approved_at = now()
       where id = new.payable_id
         and status = 'pending_approval';
    end if;
    return new;
  end if;

  -- landlord_payout: unchanged from 0152 -- the chain gates
  -- claim_remittance_for_sending directly, there is no status field on
  -- remittances this trigger needs to move.
  return new;
end;
$function$;

comment on function apply_chain_outcome_to_payment is
  'Moves a payable to approved (stage 3 clears) or rejected (any stage refuses), per payable_type. vendor_payment requires status=recommended first (its own B4 verification/KPI gate, separate from the chain); ops_requisition has no such prior gate and moves straight from pending_approval; landlord_payout has no status field here at all -- 0152 gates it at send time instead (0171).';
