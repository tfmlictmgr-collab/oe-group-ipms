-- The override asked for an account the refusal had not yet made
-- (9 Sept 2026).
--
-- 📌 Numbered 0283, not 0281 — written and applied to staging/dev under
-- `0281_the_override_asked_for_an_account_the_refusal_had_not_yet_made.sql`,
-- then renumbered before this file (or its tracking row) reached anyone else,
-- on finding a second, unrelated `0281` and an announced `0282` already
-- claimed by a peer session working the same repo concurrently. `_migrations`
-- tracks by full filename, so this rename is cosmetic for what had already
-- run — the tracking row was renamed to match, not re-applied.
--
-- Reported live, with the refusal still on screen after the payment-officer
-- override had already shipped: "Olayinka's Estate's service-charge fund
-- cannot cover this... Nothing has been sent." — the exact `0272` refusal, on
-- a payment `0272` was written to give a way past.
--
-- Two faults, not one, and the first was found and fixed on the way to
-- proving the second.
--
-- ── 1. The override control had no screen to stand on (app-layer, no
--       migration) ──────────────────────────────────────────────────────
--
-- `authoriseShortFund` (0272) has taken `payableType: "vendor_payment" |
-- "ops_requisition"` since it was written, and `payable_fund_override_state`/
-- `authorise_fund_override` have resolved a vendor payment's account
-- correctly the whole time. But the function was only ever CALLED from the
-- requisition's own send flow (`SendLineGroup.tsx`) — a vendor payment
-- hitting the identical refusal on `/dashboard/payments/<id>` had no control
-- to reach it at all, ever, on this screen. `PaymentActions.tsx` now carries
-- the same panel, wired to the same action.
--
-- ── 2. And once reachable, the override itself could not be authorised for
--       most properties (this migration) ──────────────────────────────────
--
-- ⚠️ Proven live, not assumed: with the control finally reachable, authorising
-- it against THIS payment (Olayinka's Estate, ₦350,000) returned a SECOND
-- refusal — "This payment has no property fund to authorise against." — a
-- message `authoriseShortFund` prints when `payable_fund_override_state`
-- resolves no account, worded for a payment with no property attached at all.
-- This payment plainly has one; the refusal on screen NAMES the building.
--
-- The cause: `ensure_property_ledger_account` (0247) creates a property's
-- service-charge sub-account **lazily, inside the same transaction as the
-- posting that needed it** — and the posting that needed it is exactly the
-- one `assert_funds_available` is about to REFUSE. The refusal rolls the
-- whole transaction back, sub-account creation included, so the account this
-- migration's own header describes is created and destroyed in the same
-- breath every time the fund is short. `payable_fund_override_state`, called
-- afterward in its OWN transaction, did a passive `select … from
-- ledger_accounts` for a row that transaction never left behind: measured
-- live, only **2 of the platform's properties** (Osborne Tower,
-- PROBEFUND-Tower-QO92O) have ever had a sub-account persist, because only
-- those two have ever had a SUCCESSFUL posting create one. Every other
-- property's override was unreachable by construction — not flaky, not rare,
-- the majority case.
--
-- 📌 The same shape decision 24 keeps finding: a helper written for the case
-- that was in front of the author (an account that already exists) and
-- silently wrong for the one that wasn't (an account that has never yet been
-- needed) — which is, precisely, every property whose fund has never once
-- run short before.
--
-- The fix asks for the account the way the posting itself would: through
-- `ensure_property_ledger_account`, which opens it if absent and returns the
-- existing one otherwise (idempotent — a second call, from the real
-- remittance retried after the override, resolves to the SAME row). No
-- longer `stable`: it now genuinely writes, exactly once, the sub-account a
-- successful collection would eventually have created anyway.

create or replace function payable_fund_override_state(p_payable_type text, p_payable_id uuid)
returns table (
  account_id uuid,
  authorised boolean,
  reason text,
  authorised_by text,
  authorised_at timestamptz
)
language plpgsql security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_prop uuid;
  v_acct uuid;
begin
  if p_payable_type = 'vendor_payment' then
    select p.org_id into v_org from payments p where p.id = p_payable_id;
  elsif p_payable_type = 'ops_requisition' then
    select r.org_id into v_org from ops_requisitions r where r.id = p_payable_id;
  else
    return;
  end if;
  if v_org is null then return; end if;
  if auth.uid() is not null and v_org is distinct from current_user_org_id() then
    raise exception 'that payable belongs to another organisation';
  end if;

  v_prop := payable_property_id(p_payable_type, p_payable_id);

  if v_prop is not null then
    -- ⚠️ The fix. `ensure_property_ledger_account` OPENS the sub-account when
    -- it is not already there — the same call a successful collection makes —
    -- rather than a passive read that only ever finds one AFTER something has
    -- posted against it and survived. Idempotent: the remittance retried after
    -- an authorisation resolves to this exact row, never a second one.
    v_acct := ensure_property_ledger_account(v_org, 'service_charge_fund'::ledger_account_purpose, v_prop, 'NGN');
  else
    select la.id into v_acct
      from ledger_accounts la
     where la.org_id = v_org
       and la.purpose = 'service_charge_fund'
       and la.currency = 'NGN'
       and la.property_id is null;
  end if;

  return query
  select
    v_acct,
    o.id is not null,
    o.reason,
    u.full_name,
    o.created_at
  from (select 1) _
  left join lateral (
    select * from fund_overrides fo
     where fo.account_id = v_acct and fo.consumed_at is null
     order by fo.created_at limit 1
  ) o on true
  left join users u on u.id = o.authorised_by;
end;
$fn$;

revoke all on function payable_fund_override_state(text, uuid) from public, anon;
grant execute on function payable_fund_override_state(text, uuid) to authenticated, service_role;

comment on function payable_fund_override_state is
  'The fund an override for this payable would be authorised against, opening its per-property sub-account if it does not exist yet (0283 — the passive read in 0272 could only ever find one AFTER a successful posting had already created it, which most properties have never had). Also reports whether a live, unconsumed authorisation already stands.';

-- ── Prove it against the exact live case that was reported ────────────────
--
-- Olayinka's Estate had no sub-account at the time this was written — that
-- absence is the bug. Asserted generally, not by property name, so the check
-- still means something once the account exists: ANY property-attached
-- payable must resolve a real account.
do $$
declare
  v_org uuid;
  v_prop uuid;
  v_acct uuid;
begin
  select t.org_id, t.property_id
    into v_org, v_prop
    from payments p join tickets t on t.id = p.ticket_id
   where p.id = '27d8201a-1198-420a-8e30-6a39396fbdfb';

  if v_prop is null then
    raise notice 'the reported payment no longer names a property — skipping the targeted check';
  else
    select account_id into v_acct
      from payable_fund_override_state('vendor_payment', '27d8201a-1198-420a-8e30-6a39396fbdfb');

    if v_acct is null then
      raise exception
        'payable_fund_override_state still resolves no account for the reported payment (property %)', v_prop;
    end if;

    if not exists (select 1 from ledger_accounts where id = v_acct and property_id = v_prop) then
      raise exception 'the resolved account does not belong to the payment''s own property';
    end if;
  end if;
end $$;
