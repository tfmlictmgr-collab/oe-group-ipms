-- Bulk approval survives the chain, as stage 3.
--
-- ⚠️ 0151 made approval the outcome of a three-stage chain rather than a status
-- a role may set. `approve_payments()` (0127) still wrote `status = 'approved'`
-- directly, so every id it touched came back with "this payment has not
-- completed its approval chain" — a shipped button that could no longer succeed
-- at anything. Found by `verify-finance-journey`, 16 checks, after the chain's
-- own suite passed 49/49: **a change can be entirely correct in its own tests
-- and still break the feature next to it.**
--
-- 📌 The use case is real and worth keeping: a tier-2 approver clearing twelve
-- small invoices on a Friday should not click through twelve screens. What
-- changes is WHICH act is being repeated. It is no longer "set approved" — it
-- is "record my stage-3 decision", which lands on `record_payment_approval` and
-- therefore inherits every rule the single path has: role, tier against the
-- amount, separation of duties, no proceeding past a rejection, and the
-- server-resolved amount.
--
-- Everything 0127 was careful about is preserved deliberately:
--   • the 200 cap, because this is a money path reached from a browser and
--     "select all" is one click;
--   • per-row exception handling, so one refusal does not roll back the rest;
--   • the trigger's own words passed through, rather than a third copy of the
--     rule written here;
--   • the deliberately ambiguous "not yours" reason, so a finance user in one
--     org cannot learn that a payment id in another org exists.
--
-- SECURITY INVOKER, still and for the same reason: this must be N single
-- approvals with RLS and every trigger applying, never a privileged bulk path.

create or replace function approve_payments(p_ids uuid[])
returns table (payment_id uuid, approved boolean, reason text)
language plpgsql as $$
declare
  v_id uuid;
  v_stage smallint;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  if array_length(p_ids, 1) > 200 then
    raise exception 'a batch may hold at most 200 payments (this one has %)', array_length(p_ids, 1);
  end if;

  foreach v_id in array p_ids loop
    begin
      -- Which stage is actually next on THIS payment. A batch will usually be
      -- all stage 3, but a mixed selection is legitimate — an FM clearing their
      -- own sign-offs in bulk is the same act — and hardcoding 3 would refuse
      -- them for the wrong reason.
      select s.stage_order into v_stage
        from payment_chain_stages() s
       where not exists (
         select 1 from payment_approvals a
          where a.payable_type = 'vendor_payment'
            and a.payable_id   = v_id
            and a.stage_order  = s.stage_order
       )
       order by s.stage_order
       limit 1;

      if v_stage is null then
        payment_id := v_id; approved := false;
        reason := 'every approval stage on this payment is already complete';
        return next;
        continue;
      end if;

      -- Visibility check first, so an id that is not this caller's produces the
      -- same deliberately ambiguous answer 0127 gave rather than a trigger
      -- exception that might describe someone else's payment.
      if not exists (select 1 from payments where id = v_id and status = 'recommended') then
        payment_id := v_id; approved := false;
        reason := 'not awaiting approval, or not yours to approve';
        return next;
        continue;
      end if;

      perform record_payment_approval('vendor_payment', v_id, v_stage, 'approved', null);

      payment_id := v_id; approved := true; reason := null;
      return next;

    exception when others then
      payment_id := v_id; approved := false; reason := sqlerrm;
      return next;
    end;
  end loop;
end;
$$;

revoke all on function approve_payments(uuid[]) from public;
revoke execute on function approve_payments(uuid[]) from anon;
grant execute on function approve_payments(uuid[]) to authenticated;

comment on function approve_payments is
  'Records one stage decision on many payments in a single call, each through record_payment_approval individually — so tier, role, separation of duties and the server-resolved amount all apply exactly as they do to a single approval. Since 0155 this is the CHAIN in bulk, not a status write: 0127''s version set status directly and stopped working the day 0151 landed. SECURITY INVOKER, capped at 200, one outcome and reason per id.';

-- ── The limit a person is shown ───────────────────────────────────────────
--
-- `my_approval_limit()` returned the single org threshold, which described a
-- model with one cut-off. There are three bands now, and what a person needs to
-- know is the ceiling THEY can clear — which for a tier-1 approver is the
-- tier-1 threshold, not the org's.
-- ⚠️ The RETURN SHAPE is kept exactly as 0127 defined it —
-- `TABLE(threshold, unlimited, may_approve)`. Two call sites read those three
-- columns, and a scalar would have been a silent breakage at runtime rather
-- than a compile error. Only the VALUES change: `threshold` is now the
-- person's own band ceiling rather than the org's single cut-off.
create or replace function my_approval_limit()
returns table (threshold numeric, unlimited boolean, may_approve boolean)
language sql stable security definer set search_path = public as $$
  select
    case effective_approval_tier(u.role, u.approval_tier)
      when 1 then coalesce(s.tier1_threshold_amount, 100000)
      when 2 then coalesce(s.approval_threshold_amount, 1000000)
      else null                                  -- tier 3, or no authority
    end,
    effective_approval_tier(u.role, u.approval_tier) = 3,
    effective_approval_tier(u.role, u.approval_tier) is not null
    from users u
    left join payment_settings s on s.org_id = u.org_id
   where u.id = auth.uid();
$$;

revoke all on function my_approval_limit() from public;
revoke execute on function my_approval_limit() from anon;
grant execute on function my_approval_limit() to authenticated;

comment on function my_approval_limit is
  'The most this person may give FINAL APPROVAL to, in naira. Null means unlimited (tier 3); zero means they hold no final-approval authority at all. Their own band, not the org''s single threshold — since 0151 there are three (0155).';
