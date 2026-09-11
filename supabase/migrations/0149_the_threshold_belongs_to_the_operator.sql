-- An administrator who can raise the limit they approve against has not been
-- limited.
--
-- Decision 16 (8 Aug 2026) broke the disbursement concentration: an admin who
-- approves a payment can no longer release it. It left the other half standing.
-- `payment_settings.approval_threshold_amount` is still writable by any
-- administrator of the org (0004's `payment_settings_write`), and
-- `enforce_payment_transition` reads that same number to decide whether a
-- payment needs an administrator or an executive. So:
--
--   1. an admin meets a ₦5,000,000 payment that needs executive sign-off;
--   2. the admin edits the threshold to ₦10,000,000;
--   3. the admin approves it alone.
--
-- Nothing in the database refuses any of those three steps today. The audit
-- trail records all of them, which is how it would eventually be found — but a
-- control that only produces evidence after the money has gone is a report,
-- not a control.
--
-- ⚠️ This is the SAME reasoning 0072b already applied to `executive`:
-- "approving against a threshold you can raise yourself is not an approval."
-- That sentence was written to justify keeping `payment_settings_write` away
-- from the MD. It was never applied to the administrator, who has both powers
-- and, unlike the executive, is the role the escalation actually escalates TO.
--
-- 📌 Why the OPERATOR and not a new super-admin role. The obvious fix is a role
-- above `admin` that owns the config. `0078d` deliberately refused to add one —
-- "the thing this system deliberately does not have" — because an org that
-- cannot appoint its own second administrator eventually asks someone with
-- database access to do it, and that becomes the norm. Decision 7 already put
-- governance of what staff may reach on the OPERATOR portal, with brand
-- administrators read-only, and named the payment-approval threshold a
-- non-delegable control in the same breath. The threshold is governance of the
-- same kind. It goes where the rest of the governance already lives, through
-- one audited SECURITY DEFINER function rather than a cross-org policy.
--
-- What does NOT change: fees. `admin_fee_percent` sits in this same table and
-- is a commercial term the brand negotiates (decision 14), not a control an
-- auditor checks. Moving the whole table to the operator would take a
-- legitimate power away from the people whose business it is. Hence a
-- COLUMN-level guard, not a table-level one.

-- ── The two control columns, named once ───────────────────────────────────
--
-- A trigger rather than an RLS predicate because RLS `with check` cannot see
-- OLD, and the rule is about a CHANGE to two columns, not about the row. The
-- same shape as `enforce_payment_transition` and `block_removing_last_admin`.
create or replace function enforce_payment_gate_config_authority()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_changed text[] := '{}';
begin
  -- Trusted system/seed writes (service role) are exempt, exactly as every
  -- other money trigger in this schema treats them.
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A first row for an org establishes both control values. Creating the row
    -- is provisioning, which is already an operator action.
    if new.approval_threshold_amount is distinct from 1000000
       or new.min_performance_score is distinct from 70 then
      if not caller_is_operator_admin() then
        raise exception
          'the approval limit and the performance gate are set by OE Group, not by the organisation — ask your OE Group contact to change them';
      end if;
    end if;
    return new;
  end if;

  -- ⚠️ `array_append`, not `||`. With an unknown-type literal on the right,
  -- Postgres resolves `||` to the array-to-array operator and tries to parse
  -- 'the approval limit' AS an array — "malformed array literal". The first
  -- run of verify-payment-gate-authority reported the admin's write as
  -- correctly refused; it was being refused by THIS bug, one line before the
  -- authority check it was supposed to be testing. A refusal for the wrong
  -- reason passes a test and protects nothing.
  if new.approval_threshold_amount is distinct from old.approval_threshold_amount then
    v_changed := array_append(v_changed, 'the approval limit');
  end if;
  if new.min_performance_score is distinct from old.min_performance_score then
    v_changed := array_append(v_changed, 'the performance gate');
  end if;

  if array_length(v_changed, 1) is null then
    return new;   -- fees and other columns: the administrator's to change
  end if;

  if not caller_is_operator_admin() then
    raise exception
      '% % set by OE Group, not by the organisation — an administrator who can raise the limit they approve against has not been limited',
      array_to_string(v_changed, ' and '),
      case when array_length(v_changed, 1) > 1 then 'are' else 'is' end;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_payment_gate_config_authority on payment_settings;
create trigger trg_payment_gate_config_authority
  before insert or update on payment_settings
  for each row execute function enforce_payment_gate_config_authority();

comment on function enforce_payment_gate_config_authority is
  'Refuses a change to approval_threshold_amount or min_performance_score from anyone but an OE Group operator administrator. Column-level by design: the fee columns in the same table stay with the brand administrator (decision 14), while the two columns enforce_payment_transition reads become operator-governed (0149).';

-- ── The operator''s way in ────────────────────────────────────────────────
--
-- Decision 7: crossings are "routed through one audited SECURITY DEFINER
-- function, never a cross-org policy". `payment_settings_write` stays exactly
-- as it is — an operator admin fails its `org_id = current_user_org_id()` test
-- and always will, which is correct. This function is the crossing.
-- ⚠️ Rebuilt from the LIVE list, not from 0079's. This constraint has been
-- widened twice already (0083 added retire/unretire, 0089 added set_org_domain)
-- and the first draft of this migration reinstated 0079's four values, which
-- dropped three live ones and was refused by existing rows. Same trap 0136
-- documented for function bodies: the newest migration that touched a thing is
-- the definition, never the one that created it.
alter table operator_actions drop constraint if exists operator_actions_action_check;
alter table operator_actions add constraint operator_actions_action_check
  check (action in ('provision_org', 'suspend_user', 'unsuspend_user', 'break_glass',
                    'retire_org', 'unretire_org', 'set_org_domain',
                    'set_payment_gate'));

create or replace function operator_set_payment_gate(
  p_org_id    uuid,
  p_threshold numeric,
  p_min_score numeric,
  p_reason    text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_operator_org uuid;
  v_old payment_settings%rowtype;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may set an approval limit';
  end if;

  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'say why this limit is changing, in at least 10 characters — it is the record an auditor reads';
  end if;

  if p_threshold is null or p_threshold <= 0 then
    raise exception 'an approval limit must be greater than zero';
  end if;
  if p_min_score is null or p_min_score < 0 or p_min_score > 100 then
    raise exception 'the performance gate must be a score between 0 and 100';
  end if;

  select id into v_operator_org from orgs where id = current_user_org_id();
  select * into v_old from payment_settings where org_id = p_org_id;

  insert into payment_settings (org_id, approval_threshold_amount, min_performance_score, updated_at)
  values (p_org_id, p_threshold, p_min_score, now())
  on conflict (org_id) do update
    set approval_threshold_amount = excluded.approval_threshold_amount,
        min_performance_score     = excluded.min_performance_score,
        updated_at                = now();

  -- Visible to the organisation it was done TO, not only to the operator —
  -- 0079's rule, and the reason operator_actions exists at all.
  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (
    auth.uid(), v_operator_org, p_org_id, 'set_payment_gate', trim(p_reason),
    jsonb_build_object(
      'approval_threshold_before', v_old.approval_threshold_amount,
      'approval_threshold_after',  p_threshold,
      'min_score_before',          v_old.min_performance_score,
      'min_score_after',           p_min_score
    )
  );
end;
$$;

revoke all on function operator_set_payment_gate(uuid, numeric, numeric, text) from public, anon;
grant execute on function operator_set_payment_gate(uuid, numeric, numeric, text) to authenticated, service_role;

comment on function operator_set_payment_gate is
  'The one audited path by which the approval limit and KPI gate change. Operator administrators only, requires a stated reason, and records the before/after on operator_actions where the affected organisation can read it (0149).';
