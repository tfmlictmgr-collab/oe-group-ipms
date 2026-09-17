-- Approval is tierless unless an organisation asks for bands
-- (board, 5 Sept 2026).
--
-- Reported: OEA's payment approver could not clear a ₦340,000 vendor invoice —
-- "Waiting on a payment approver at tier 2 — ₦340,000.00 needs that band or
-- above." The approver holds tier 1. Nothing was broken; the tier ladder was
-- doing exactly what it was built to do, and the board does not want it doing
-- that here.
--
-- ⚠️ This is NOT what `0248` made optional, and conflating the two is the
-- mistake this migration exists to correct. `0248` made the NUMBER OF STAGES
-- configurable (`approval_chain_shape`). The thing blocking the payment is the
-- TIER BAND on the final stage — a separate gate, `resolve_required_tier()`
-- against `effective_approval_tier()`, which no shape ever switched off. An org
-- could be moved to `single_stage` and still be blocked by exactly this.
--
-- The board's position: at OEA every outbound payment already climbs to the
-- Managing Partner (decision 23), so a second, amount-based hurdle behind them
-- adds no control and does block work. Bands become an opt-in, and the default
-- is OFF.
--
-- ── Why the default is OFF for everyone, not just OEA ──────────────────────
--
-- ⚠️ Stated plainly because it is a real reduction: this switches the tier gate
-- off for TFML and every other org too, not only OEA. "Approvals should default
-- to tierless" is the instruction, and a default that applies to one org and
-- not another is the drift `0185` was written about. What is NOT reduced:
--   • the CHAIN still runs in full — audit, MP, payment approval, three pairs
--     of hands on the OEA ladder;
--   • maker-checker is untouched (one human, one stage);
--   • `assert_may_disburse` and decision 16 are untouched — only the payment
--     officer releases money, and never the person who approved it.
-- What is removed is only the requirement that the approver's band be >= the
-- band the amount resolves to. An org that wants it back sets one flag.
--
-- ── Where the switch lives ─────────────────────────────────────────────────
--
-- Operator-governed, exactly like `approval_chain_shape` (0248) — decision 7
-- names "payment approval (incl. the threshold escalation)" among the controls
-- that "stay hardwired and never appear as toggles" in an ORG's own settings.
-- 📌 The board's message said "at best… a toggle in the org-admin permissions".
-- It is built as an operator toggle instead, for consistency with the ratified
-- choice on the chain shape three commits ago, and because an administrator who
-- can switch off the band they approve against is approving against nothing.
-- Moving it to the org's own Settings is a one-line change if the board prefers
-- that, and should be a recorded exception to decision 7 rather than a quiet
-- edit.

alter table orgs
  add column if not exists approval_tiers_enabled boolean not null default false;

comment on column orgs.approval_tiers_enabled is
  'Whether the final approval stage checks the approver''s tier band against the amount. OFF by default (board, 5 Sept 2026): the chain still runs in full, but no amount-based band is required. Operator-set only — deliberately absent from the authenticated UPDATE column allowlist, like approval_chain_shape.';

-- ── The one lever ──────────────────────────────────────────────────────────
--
-- `tier_resolved` is read in exactly one place that matters —
-- `enforce_approval_rules`, whose whole tier block is `if v_stage.tier_resolved
-- ...` — so switching it off here switches off the band check, the
-- "you do not carry an approval limit" refusal, and the `required_tier` stamp
-- together, with no second rule to keep in step.
--
-- Rebuilt from the live catalogue (0183); the only change is that stage 3's
-- literal `true` — and `single_stage`'s stage 1 — now ask the org.
create or replace function payment_chain_stages(p_org_id uuid)
returns table(stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql stable set search_path = public as $fn$
  select v.stage_order, v.required_roles, v.tier_resolved, v.label
    from (
      select org_payment_chain(p_org_id) as shape,
             coalesce(
               (select o.approval_tiers_enabled from orgs o where o.id = p_org_id),
               false
             ) as tiers
    ) c
    cross join lateral (values
      (1::smallint,
       case c.shape when 'oea'          then array['payment_audit_approver']::user_role[]
                    when 'single_stage' then array['payment_approver','executive']::user_role[]
                    else fm_roles() end,
       case c.shape when 'single_stage' then c.tiers else false end,
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
       c.tiers,
       case c.shape when 'oea' then 'Payment approval'
                    else 'Final approval' end::text)
    ) as v(stage_order, required_roles, tier_resolved, label)
   where c.shape <> 'single_stage' or v.stage_order = 1;
$fn$;

-- ── And nothing claims a band is needed ────────────────────────────────────
--
-- The screen reads `resolve_required_tier` to say "Requires Tier 2". With bands
-- off there is no band to require, and leaving this returning 2 would print a
-- requirement that no longer exists — a page telling somebody they need
-- something the database has stopped asking for.
create or replace function resolve_required_tier(p_org_id uuid, p_amount numeric)
returns smallint language sql stable set search_path = public as $fn$
  select case
           when not coalesce(
                  (select o.approval_tiers_enabled from orgs o where o.id = p_org_id),
                  false
                ) then 1::smallint
           when p_amount <= coalesce(s.tier1_threshold_amount, 100000)      then 1::smallint
           when p_amount <= coalesce(s.approval_threshold_amount, 1000000)  then 2::smallint
           else 3::smallint
         end
    from (select 1) _
    left join payment_settings s on s.org_id = p_org_id;
$fn$;

-- ── Turning bands back on ──────────────────────────────────────────────────
create or replace function operator_set_approval_tiers(p_org_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  v_before boolean;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an OE Group operator administrator may switch approval tiers on or off';
  end if;

  select approval_tiers_enabled into v_before from orgs where id = p_org_id;
  if not found then
    raise exception 'no such organisation';
  end if;

  update orgs set approval_tiers_enabled = coalesce(p_enabled, false) where id = p_org_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    p_org_id, auth.uid(), 'payment_chain.tiers_changed', 'orgs', p_org_id,
    jsonb_build_object('approval_tiers_enabled', v_before),
    jsonb_build_object('approval_tiers_enabled', coalesce(p_enabled, false))
  );
end;
$fn$;

-- What the UI needs to know, without reading `orgs` directly: an approver is
-- not an administrator and holds no general read on the org record.
create or replace function org_approval_tiers_enabled(p_org_id uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce((select o.approval_tiers_enabled from orgs o where o.id = p_org_id), false);
$fn$;

revoke all on function operator_set_approval_tiers(uuid, boolean) from public, anon;
revoke all on function org_approval_tiers_enabled(uuid) from public, anon;
revoke all on function payment_chain_stages(uuid) from public, anon;
revoke all on function resolve_required_tier(uuid, numeric) from public, anon;
grant execute on function operator_set_approval_tiers(uuid, boolean) to authenticated, service_role;
grant execute on function org_approval_tiers_enabled(uuid) to authenticated, service_role;
grant execute on function payment_chain_stages(uuid) to authenticated, service_role;
grant execute on function resolve_required_tier(uuid, numeric) to authenticated, service_role;

do $$
declare
  v_bad text;
  v_oea uuid;
  v_tiered int;
begin
  -- The column is closed to org-level roles, same as approval_chain_shape.
  select string_agg(grantee || ' → ' || column_name, ', ') into v_bad
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'orgs'
     and column_name = 'approval_tiers_enabled'
     and privilege_type = 'UPDATE'
     and grantee in ('authenticated', 'anon', 'PUBLIC');
  if v_bad is not null then
    raise exception 'orgs.approval_tiers_enabled is writable by an org-level role: %', v_bad;
  end if;

  select string_agg(distinct routine_name || ' → ' || grantee, ', ') into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public' and grantee in ('anon', 'PUBLIC')
     and routine_name in ('operator_set_approval_tiers', 'org_approval_tiers_enabled',
                          'payment_chain_stages', 'resolve_required_tier');
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;

  -- No stage anywhere still demands a band.
  select count(*) into v_tiered
    from orgs o
    cross join lateral payment_chain_stages(o.id) s
   where o.deleted_at is null and s.tier_resolved;
  if v_tiered > 0 then
    raise exception '% stage(s) still resolve a tier band despite the default being off', v_tiered;
  end if;

  raise notice 'approval is tierless: the chain still runs in full, and no stage requires a band.';
end $$;
