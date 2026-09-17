-- Batch approval — twenty invoices, one action, twenty separate gates.
--
-- A finance lead sits down to a week's vendor invoices and approves them one
-- page at a time. That is the whole of the request; the interesting part is
-- what a batch must NOT become.
--
-- ⚠️ A batch must not be a shortcut past the gate. `enforce_payment_transition`
-- (0073) is a BEFORE UPDATE ... FOR EACH ROW trigger, so it fires per row on a
-- multi-row UPDATE and cannot be skipped by updating many at once. That is the
-- reason this function is deliberately **SECURITY INVOKER**: it runs as the
-- caller, RLS applies, the trigger applies, and the batch is exactly N single
-- approvals — not a privileged path that happens to do N things.
--
-- ⚠️ And a batch must not be all-or-nothing. A single `update ... where id =
-- any($1)` is one statement: if the seventeenth payment sits above the
-- caller's approval threshold, the statement raises and NONE of the twenty are
-- approved. The finance lead is then told "approvals above ₦1,000,000 require
-- an administrator" with no indication of which one, and no work done. So each
-- row gets its own exception block and its own answer, and the caller is told
-- per row what happened.
--
-- What is NOT re-implemented here is the gate itself. The trigger already
-- decides legality, the verification/performance conditions, who may approve,
-- and the threshold escalation. This function catches its refusal and reports
-- it. Two copies of a money rule drift — and they already have, which is the
-- next thing this file fixes.

create or replace function approve_payments(p_ids uuid[])
returns table (payment_id uuid, approved boolean, reason text)
language plpgsql as $$
declare
  v_id uuid;
  v_n integer;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;

  -- A cap, because this is a money path reached from a browser and "select
  -- all" on a long list is one click. Two hundred is far above any real
  -- week's invoices and far below anything that could be used to hammer the
  -- trigger.
  if array_length(p_ids, 1) > 200 then
    raise exception 'a batch may hold at most 200 payments (this one has %)', array_length(p_ids, 1);
  end if;

  foreach v_id in array p_ids loop
    begin
      update payments
         set status = 'approved',
             approved_by = auth.uid(),
             approved_at = now()
       where id = v_id
         -- Only from `recommended`. The trigger would refuse any other source
         -- state anyway; naming it here means an already-approved payment
         -- comes back as a skip with a plain reason rather than as an
         -- exception message about an illegal transition.
         and status = 'recommended';
      get diagnostics v_n = row_count;

      if v_n = 1 then
        payment_id := v_id; approved := true;  reason := null;
      else
        -- Zero rows is ambiguous by design and must not be reported as though
        -- it were: the payment may not exist, may not be visible to this
        -- caller under RLS, or may simply not be at `recommended`. Saying
        -- which would tell a finance user in one org that a payment id in
        -- another org exists.
        payment_id := v_id; approved := false;
        reason := 'not awaiting approval, or not yours to approve';
      end if;
      return next;

    exception when others then
      -- The trigger's own words, passed through. They are written for a person
      -- ("approvals above 1000000 require an administrator or an executive")
      -- and rewriting them here would be a third copy of the rule.
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
  'Approves many payments in one call, each through enforce_payment_transition individually. SECURITY INVOKER on purpose: RLS and the payment gate both still apply, so this is N single approvals rather than a privileged bulk path. Per-row exception handling means one refusal does not roll back the rest -- the caller gets an outcome and a reason for every id. Capped at 200.';

-- ── The two copies that had already drifted ───────────────────────────────
--
-- ⚠️ `approvePayment` in app/dashboard/payments/[id]/actions.ts re-implements
-- the threshold gate in TypeScript:
--
--     if (Number(payment.amount) > threshold && approver?.role !== "admin")
--
-- The trigger says:
--
--     if new.amount > v_threshold and caller_role not in ('admin','executive')
--
-- The board added `executive` on 29 July 2026 — the MD of TFML and the
-- Managing Partner of OEA "co-hold payment approval, INCLUDING ABOVE THE
-- THRESHOLD" (decision 9). 0073 put that in the trigger. The application check
-- was never updated, so it is stricter than the board decision: an MD is
-- refused in the UI, told to "ask an administrator", for a payment the
-- database would have accepted from them.
--
-- Proven before writing this, then rolled back: the TFML executive approving a
-- ₦5,000,000 payment against a ₦1,000,000 threshold — ALLOWED by the trigger.
--
-- The application fix is in the same commit as this file. This view exists so
-- neither layer has to hold the number: a screen can ask what the caller may
-- approve instead of computing it, and there is one answer.
create or replace function my_approval_limit()
returns table (threshold numeric, unlimited boolean, may_approve boolean)
language sql stable security definer set search_path = public as $$
  select
    coalesce(ps.approval_threshold_amount, 1000000)::numeric,
    -- Who the escalation reaches. Deliberately the same list as the trigger's
    -- `caller_role not in ('admin','executive')`, and if that ever changes this
    -- is the one other place to change.
    current_user_role() = any (array['admin','executive']::user_role[]),
    current_user_role() = any (array['finance_approver','admin','executive']::user_role[])
  from (select 1) _
  left join payment_settings ps on ps.org_id = current_user_org_id();
$$;

revoke all on function my_approval_limit() from public;
revoke execute on function my_approval_limit() from anon;
grant execute on function my_approval_limit() to authenticated;

comment on function my_approval_limit is
  'What the CALLER may approve: the org threshold, whether they are exempt from it (admin/executive -- the board''s decision-9 escalation), and whether they may approve at all. Exists so the UI can ask rather than re-derive; an application copy of this rule had already drifted from enforce_payment_transition and was refusing executives the board had authorised.';
