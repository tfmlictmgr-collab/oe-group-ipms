-- 📌 9 Oct 2026. The segregation headline said "covered" while client money was short.
--
-- Read from OEA production's own Client Funds statement after the walkthrough:
--
--     Held   ₦816.65   (1000 Client funds)
--     Owed   ₦716.65   = 2100 Landlord ₦900.00 + 2000.001 Akpabio 01 fund −₦183.35
--     Unallocated ₦100  "Money held covers everything owed to clients."
--
-- Akpabio 01's fund held ₦16.65 and paid a ₦200 vendor under a fund override, so
-- it is OVERDRAWN by ₦183.35. `client_funds_position` summed liabilities by their
-- natural balance, so the overdrawn fund was ADDED to what is owed as a negative
-- number and quietly cancelled ₦183.35 of the landlord's ₦900. The truth: the
-- landlord is owed ₦900 and ₦816.65 is held — client money is ₦83.35 short,
-- because one building's vendor was paid partly with another client's rent
-- (decision 27's exact subject). The override permitted the payment, correctly
-- and with a reason; what was wrong is that the one figure that exists to say
-- "client money is intact" then said so.
--
-- ⚠️ An overdrawn fund is not "less owed". It is money spent that its building
-- never held, and it has to come back from somewhere — the building's next
-- collection, or the organisation's own money. So:
--
--   • `funds_owed` counts each liability account only where it is OWED
--     (natural balance above zero). An overdrawn account contributes nothing
--     to it and can no longer cancel another account's debt.
--   • `funds_overdrawn` (new, appended) states the overdrawn total on its own,
--     with `overdrawn_accounts` saying how many accounts carry it.
--   • `unallocated` = held − owed, as before, so the shortfall now appears.
--
-- 📌 And the list of what is owed was one purpose short twice over. The view
-- named landlord, vendor, deposit and service-charge accounts, but the chart
-- also holds `requisition_payable` (2400 — an approved requisition not yet paid
-- is money owed to its payee) and `suspense` (9000 — money received that is not
-- yet identified is still somebody's). The Balances page's own drawer already
-- listed 2400 as "owed" (SegregationStats.tsx), so the tile and its drawer
-- disagreed about one account. Both now count, in one list.
--
-- Nothing changes for an organisation with no overdrawn fund, no requisition
-- payable and no suspense balance: every term added is zero for it.
--
-- 📌 The same in `operator_consolidated_position` (0131), which computes the
-- position independently for the operator's consolidated view. Rebuilt from
-- the live catalogue through a swap that refuses unless it matches exactly once.
--
-- ── The fund override recorded the wrong number ─────────────────────────────
-- `authorise_fund_override` (0272) stored `greatest(raw_balance, 0)` as
-- `shortfall_at_authorisation`. A liability's raw balance is negative while it
-- holds money, so for every fund that was not ALREADY overdrawn this stored 0 —
-- production's only override reads ₦0.00 against a payment that overdrew the
-- fund by ₦183.35. The amount a payment overruns a fund is only known when it
-- posts, so it is now recorded there, in `assert_funds_available`, at the moment
-- the override is consumed (`shortfall_covered`). Authorisation records what the
-- fund held at that moment (`fund_balance_at_authorisation`), and the old column
-- keeps its literal meaning, now stated: how far the fund was already overdrawn.
-- Existing overrides are repaired from the postings themselves.

-- ── 1. The position ─────────────────────────────────────────────────────────
create or replace view client_funds_position with (security_invoker = on) as
  select
    b.org_id,
    sum(b.natural_balance) filter (where b.purpose = 'client_funds') as funds_held,
    sum(greatest(b.natural_balance, 0)) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
    ) as funds_owed,
    (
      coalesce(sum(b.natural_balance) filter (where b.purpose = 'client_funds'), 0)
      - coalesce(sum(greatest(b.natural_balance, 0)) filter (
          where b.class = 'liability'
            and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
        ), 0)
    )::numeric(16,2) as unallocated,
    b.currency,
    coalesce(sum(greatest(-b.natural_balance, 0)) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
    ), 0)::numeric(16,2) as funds_overdrawn,
    count(*) filter (
      where b.class = 'liability'
        and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
        and b.natural_balance < 0
    ) as overdrawn_accounts
  from ledger_account_balances b
  group by b.org_id, b.currency;

comment on view client_funds_position is
  'The segregation position per org per currency. funds_owed counts each client liability only where it is owed (an overdrawn account never cancels another account''s debt); funds_overdrawn states overdrawn accounts separately; unallocated = held - owed, negative = shortfall. 0317.';

-- ── 2. The operator's consolidated view, the same rule ─────────────────────
do $$
declare
  d text;
  old_acl text;
  old_txt constant text := $o$      sum(b.natural_balance) filter (
        where b.class = 'liability'
          and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund')
      ) as funds_owed$o$;
  new_txt constant text := $n$      sum(greatest(b.natural_balance, 0)) filter (
        where b.class = 'liability'
          and b.purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
      ) as funds_owed$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.operator_consolidated_position(date, date)'::regprocedure;
  -- Line endings differ between worlds (a body created from a CRLF file keeps its CRs), so
  -- the swap compares and rebuilds on CR-free text on both sides.
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, replace(old_txt, E'\r', ''), ''))) / length(replace(old_txt, E'\r', '')) <> 1 then
    raise exception 'operator_consolidated_position: expected the funds_owed expression exactly once';
  end if;
  execute replace(d, replace(old_txt, E'\r', ''), replace(new_txt, E'\r', ''));
  if (select p.proacl::text from pg_proc p where p.oid = 'public.operator_consolidated_position(date, date)'::regprocedure) is distinct from old_acl then
    raise exception 'operator_consolidated_position: grants changed by the rebuild';
  end if;
end $$;

-- ── 3. The override's own record ───────────────────────────────────────────
alter table fund_overrides
  add column if not exists shortfall_covered numeric(16,2),
  add column if not exists fund_balance_at_authorisation numeric(16,2);

comment on column fund_overrides.shortfall_at_authorisation is
  'How far the fund was ALREADY overdrawn when the override was authorised (0 = it was not). Not the shortfall the payment created: see shortfall_covered.';
comment on column fund_overrides.shortfall_covered is
  'How far the fund was left overdrawn by the posting that consumed this override - the amount of other money the payment used. Written by assert_funds_available. 0317.';
comment on column fund_overrides.fund_balance_at_authorisation is
  'What the fund held (natural balance; negative = already overdrawn) when the override was authorised. 0317.';

do $$
declare
  d text;
  old_acl text;
  old_txt constant text := $o$      update fund_overrides o
         set consumed_at = now(),
             consumed_entry_id = coalesce(new.entry_id, old.entry_id)$o$;
  new_txt constant text := $n$      update fund_overrides o
         set consumed_at = now(),
             consumed_entry_id = coalesce(new.entry_id, old.entry_id),
             shortfall_covered = v_balance$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.assert_funds_available()'::regprocedure;
  -- Line endings differ between worlds (a body created from a CRLF file keeps its CRs), so
  -- the swap compares and rebuilds on CR-free text on both sides.
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, replace(old_txt, E'\r', ''), ''))) / length(replace(old_txt, E'\r', '')) <> 1 then
    raise exception 'assert_funds_available: expected the override consumption exactly once';
  end if;
  execute replace(d, replace(old_txt, E'\r', ''), replace(new_txt, E'\r', ''));
  if (select p.proacl::text from pg_proc p where p.oid = 'public.assert_funds_available()'::regprocedure) is distinct from old_acl then
    raise exception 'assert_funds_available: grants changed by the rebuild';
  end if;
end $$;

do $$
declare
  d text;
  old_acl text;
  o1 constant text := $o$  insert into fund_overrides (org_id, account_id, reason, authorised_by, shortfall_at_authorisation)
  values (acct.org_id, acct.id, trim(p_reason), auth.uid(), greatest(v_balance, 0))$o$;
  n1 constant text := $n$  insert into fund_overrides (org_id, account_id, reason, authorised_by, shortfall_at_authorisation, fund_balance_at_authorisation)
  values (acct.org_id, acct.id, trim(p_reason), auth.uid(), greatest(v_balance, 0), -v_balance)$n$;
  o2 constant text := $o$jsonb_build_object('reason', trim(p_reason), 'shortfall', greatest(v_balance, 0))$o$;
  n2 constant text := $n$jsonb_build_object('reason', trim(p_reason), 'fund_balance', -v_balance, 'already_overdrawn_by', greatest(v_balance, 0))$n$;
begin
  select pg_get_functiondef(p.oid), p.proacl::text into d, old_acl
    from pg_proc p where p.oid = 'public.authorise_fund_override(uuid, text)'::regprocedure;
  -- Line endings differ between worlds (a body created from a CRLF file keeps its CRs), so
  -- the swap compares and rebuilds on CR-free text on both sides.
  d := replace(d, E'\r', '');
  if (length(d) - length(replace(d, replace(o1, E'\r', ''), ''))) / length(replace(o1, E'\r', '')) <> 1 then
    raise exception 'authorise_fund_override: expected the insert exactly once';
  end if;
  if (length(d) - length(replace(d, replace(o2, E'\r', ''), ''))) / length(replace(o2, E'\r', '')) <> 1 then
    raise exception 'authorise_fund_override: expected the audit payload exactly once';
  end if;
  execute replace(replace(d, replace(o1, E'\r', ''), replace(n1, E'\r', '')), replace(o2, E'\r', ''), replace(n2, E'\r', ''));
  if (select p.proacl::text from pg_proc p where p.oid = 'public.authorise_fund_override(uuid, text)'::regprocedure) is distinct from old_acl then
    raise exception 'authorise_fund_override: grants changed by the rebuild';
  end if;
end $$;

-- ── 4. Repair the overrides already on record, from the postings ───────────
-- Raw balance (debit +) of the fund through the consuming entry = how far it
-- was left overdrawn; raw balance before authorisation, negated = what it held.
update fund_overrides o
   set shortfall_covered = (
         select coalesce(sum(p.amount), 0)
           from ledger_postings p
           join ledger_entries e on e.id = p.entry_id
          where p.account_id = o.account_id
            and (e.created_at < ce.created_at or e.id = ce.id)
       )
  from ledger_entries ce
 where ce.id = o.consumed_entry_id
   and o.shortfall_covered is null;

update fund_overrides o
   set fund_balance_at_authorisation = -(
         select coalesce(sum(p.amount), 0)
           from ledger_postings p
           join ledger_entries e on e.id = p.entry_id
          where p.account_id = o.account_id
            and e.created_at < o.created_at
       )
 where o.fund_balance_at_authorisation is null;

-- ── 5. Assertions ──────────────────────────────────────────────────────────
do $$
declare n int;
begin
  -- The view states the overdrawn total, and owed can no longer go below the
  -- sum of what is genuinely owed account by account.
  select count(*) into n
    from client_funds_position cfp
   where cfp.funds_overdrawn is null;
  if n > 0 then raise exception 'client_funds_position: funds_overdrawn is null for % row(s)', n; end if;

  select count(*) into n
    from client_funds_position cfp
    join (
      select org_id, currency, sum(natural_balance) filter (where natural_balance > 0) as pos
        from ledger_account_balances
       where class = 'liability'
         and purpose in ('landlord_payable','vendor_payable','tenant_deposit','service_charge_fund','requisition_payable','suspense')
       group by org_id, currency
    ) x on x.org_id = cfp.org_id and x.currency = cfp.currency
   where coalesce(cfp.funds_owed, 0) <> coalesce(x.pos, 0);
  if n > 0 then raise exception 'client_funds_position: funds_owed disagrees with the per-account owed total for % row(s)', n; end if;

  -- Every consumed override now says what it covered.
  select count(*) into n from fund_overrides where consumed_entry_id is not null and shortfall_covered is null;
  if n > 0 then raise exception 'fund_overrides: % consumed override(s) still have no shortfall_covered', n; end if;

  -- The view still runs as the caller (RLS decides what each person sums).
  if not exists (
    select 1 from pg_class where oid = 'public.client_funds_position'::regclass
       and reloptions @> array['security_invoker=on']
  ) then
    raise exception 'client_funds_position lost security_invoker';
  end if;
end $$;
