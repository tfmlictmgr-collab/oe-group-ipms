-- A payment chain may be one stage, and only the operator says so
-- (decision 28, 5 Sept 2026).
--
-- Asked for as "remove the tiered approval chain, or make it optional from the
-- org admin setting." The second half of that sentence is the part this
-- migration refuses, and it refuses it on the board's own record rather than on
-- taste:
--
--   • Decision 7 lists payment approval among the controls that "stay hardwired
--     and never appear as toggles: these are what an auditor checks; they are
--     not preferences."
--   • Decision 23 went further in the same direction only three weeks ago. It
--     took `delivery_brand` OUT of the `authenticated` UPDATE allowlist the
--     moment that column began choosing an approval ladder, because an
--     administrator who can pick their org's ladder can pick the one they sit
--     at the top of. Handing the ladder itself to an org admin is that same
--     escalation with the intermediate step removed.
--
-- So the shape becomes configurable and the configurer is the OE Group
-- operator, exactly as decision 7 says permissions themselves are: "operator-
-- governed, not org-governed". A brand administrator can read what shape their
-- org is on and cannot change it.
--
-- ⚠️ Nothing changes for any organisation until an operator acts. The column is
-- nullable and NULL means "derive from the brand, as before" — so this
-- migration is behaviour-preserving by construction rather than by inspection,
-- and no existing org silently loses two pairs of hands overnight.

alter table orgs
  add column if not exists approval_chain_shape text;

alter table orgs
  drop constraint if exists orgs_approval_chain_shape_check;
alter table orgs
  add constraint orgs_approval_chain_shape_check
  check (approval_chain_shape is null
         or approval_chain_shape in ('standard', 'oea', 'single_stage'));

comment on column orgs.approval_chain_shape is
  'Which payment-approval ladder this org climbs. NULL derives it from delivery_brand, exactly as before 0248. Operator-set only: deliberately absent from the authenticated UPDATE column allowlist, for the reason decision 23 removed delivery_brand from it.';

-- ── The resolver ─────────────────────────────────────────────────────────────
--
-- The brand derivation stays as the fallback rather than being backfilled into
-- the column. Backfilling would have made every org's shape an explicitly
-- stored value that then looks, to the next reader, like something somebody
-- chose — when in fact nobody has chosen anything yet.
create or replace function org_payment_chain(p_org_id uuid)
returns text
language sql stable set search_path = public as $fn$
  select coalesce(
    (select o.approval_chain_shape from orgs o where o.id = p_org_id),
    (select case when o.delivery_brand = 'OEA' then 'oea' else 'standard' end
       from orgs o where o.id = p_org_id),
    'standard'
  );
$fn$;

-- ── The ladder ───────────────────────────────────────────────────────────────
--
-- `single_stage` is ONE rung, and that rung is the payment approval — not the
-- FM sign-off and not the audit review. Collapsing a three-stage chain has to
-- keep the stage that actually authorises money leaving; keeping stage 1 as
-- written would have produced an org where a facilities manager's sign-off is
-- the whole authorisation.
--
-- `tier_resolved` is true on it for the same reason: the tier check lives on
-- the final stage (decision 23), and on this shape the final stage is the only
-- stage.
--
-- ⚠️ Disbursement is NOT a stage and is unaffected. Decision 16's rule — only
-- the payment officer releases money, and never the person who approved it —
-- is enforced in `assert_may_disburse` and the maker-checker test inside each
-- `create_*_remittance`, neither of which reads this function. An org on
-- `single_stage` still needs two different people to approve and to send.
create or replace function payment_chain_stages(p_org_id uuid)
returns table(stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql stable set search_path = public as $fn$
  select v.stage_order, v.required_roles, v.tier_resolved, v.label
    from (select org_payment_chain(p_org_id) as shape) c
    cross join lateral (values
      (1::smallint,
       case c.shape when 'oea'          then array['payment_audit_approver']::user_role[]
                    when 'single_stage' then array['payment_approver','executive']::user_role[]
                    else fm_roles() end,
       case c.shape when 'single_stage' then true else false end,
       case c.shape when 'oea'          then 'Audit review and recommendation'
                    when 'single_stage' then 'Payment approval'
                    else 'Work completed and signed off' end::text),
      (2::smallint,
       case c.shape when 'oea' then array['executive']::user_role[]
                    else array['payment_audit_approver']::user_role[] end,
       false,
       case c.shape when 'oea' then 'Managing Partner approval'
                    else 'Audit verification' end::text),
      (3::smallint,
       case c.shape when 'oea' then array['payment_approver']::user_role[]
                    else array['payment_approver','executive']::user_role[] end,
       true,
       case c.shape when 'oea' then 'Payment approval'
                    else 'Final approval' end::text)
    ) as v(stage_order, required_roles, tier_resolved, label)
   where c.shape <> 'single_stage' or v.stage_order = 1;
$fn$;

-- ── "Final stage" stops meaning "three" ──────────────────────────────────────
--
-- 0173 wrote `if new.stage_order = 3` twice, and it was right twice, because
-- both ladders were three rungs. It is the one place in the chain that did not
-- resolve the stage list dynamically — `enforce_approval_rules`,
-- `is_cleared_for_disbursement` and `chain_cleared_before` all already ask
-- `payment_chain_stages` and needed no change here.
--
-- Rebuilt from the live catalogue, with only the two literals replaced.
create or replace function apply_chain_outcome_to_payment()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_final smallint := (select max(s.stage_order) from payment_chain_stages(new.org_id) s);
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

    if new.stage_order = v_final
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

    if new.stage_order = v_final
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
$fn$;

-- ── The one way to set it ────────────────────────────────────────────────────
--
-- Gated INSIDE the function on `caller_is_operator_admin()`, the same shape
-- decision 12 used for `operator_org_directory` — and it raises rather than
-- returning empty, because unlike a directory listing there is nothing here
-- whose existence needs concealing: an org admin already knows their own org
-- has an approval chain.
create or replace function operator_set_approval_chain(p_org_id uuid, p_shape text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_before text;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may set an organisation''s approval chain';
  end if;

  if p_shape is not null and p_shape not in ('standard', 'oea', 'single_stage') then
    raise exception 'unknown approval chain shape: %', p_shape;
  end if;

  select approval_chain_shape into v_before from orgs where id = p_org_id;
  if not found then
    raise exception 'no such organisation';
  end if;

  update orgs set approval_chain_shape = p_shape where id = p_org_id;

  -- Written explicitly rather than left to the generic table trigger: this is a
  -- change to a money control, and the audit row should say so in words an
  -- auditor reads, not as a column diff on an org record.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    p_org_id, auth.uid(), 'payment_chain.shape_changed', 'orgs', p_org_id,
    jsonb_build_object('approval_chain_shape', v_before),
    jsonb_build_object('approval_chain_shape', p_shape)
  );
end;
$fn$;

comment on function operator_set_approval_chain(uuid, text) is
  'Operator-only: sets which payment-approval ladder an org climbs. NULL restores the brand default (0248).';

-- ── Who may call these ───────────────────────────────────────────────────────
revoke all on function operator_set_approval_chain(uuid, text) from public, anon;
revoke all on function org_payment_chain(uuid) from public, anon;
revoke all on function payment_chain_stages(uuid) from public, anon;

grant execute on function operator_set_approval_chain(uuid, text) to authenticated, service_role;
grant execute on function org_payment_chain(uuid) to authenticated, service_role;
grant execute on function payment_chain_stages(uuid) to authenticated, service_role;

-- The column is closed because `orgs` is granted per-column to `authenticated`
-- and a new column joins no existing grant. Asserted rather than assumed —
-- this is the exact escalation decision 23 closed for `delivery_brand`.
do $$
declare v_bad text;
begin
  select string_agg(grantee || ' → ' || column_name, ', ')
    into v_bad
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'orgs'
     and column_name = 'approval_chain_shape'
     and privilege_type = 'UPDATE'
     and grantee in ('authenticated', 'anon', 'PUBLIC');
  if v_bad is not null then
    raise exception
      'orgs.approval_chain_shape is writable by an org-level role and must not be: %', v_bad;
  end if;

  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name in ('operator_set_approval_chain', 'org_payment_chain', 'payment_chain_stages');
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
