-- Work orders are a switch, and a refused payout can be sent again
-- (requested 3 Oct 2026).
--
-- 1. WORK ORDERS. Raising planned work (`raise_work_order`, /dashboard/work)
--    was gated on `tickets.assign` — the switch for dispatching a REPORTED
--    request — so the permission matrix had no line an operator would
--    recognise as "work orders". It gets its own group and capability,
--    `workorders.raise`. Baseline is exactly who held tickets.assign, and every
--    organisation's row copies that org's CURRENT tickets.assign setting per
--    role, so an operator who had switched dispatch off for a role finds work
--    orders off for it too. Applying this file changes nobody's access.
--
-- 2. A REFUSED PAYOUT COULD NOT BE TRIED AGAIN. "Send through Paystack" creates
--    the remittance first and then checks, before claiming it, that the
--    organisation can send through Paystack at all. When that check refused
--    (no Paystack account connected; a recipient on the old shared account),
--    the remittance was left `queued`. Nothing had been sent — but it held the
--    one-live-remittance-per-payment index, so the next click, by EITHER route
--    (Paystack or "Record a bank transfer"), failed with
--      duplicate key value violates unique constraint
--      "remittances_one_live_per_payment_uidx".
--    Requisitions had the same fault, silently: the lines stayed bound to the
--    queued (or failed) payout, showed as settled, and could never be sent.
--    Each create function now closes an unclaimed `queued` payout as failed
--    (nothing left on it — the claim takes the row lock, so one in flight is
--    `sending`, not `queued`), releases requisition lines held by a failed
--    payout, and names a payout that IS live (sending/unknown/sent/reversed)
--    in words instead of a constraint name.
--
-- Rebuilt from pg_get_functiondef of a database holding 0001–0310.

set local lock_timeout = '5s';

-- ── 1. Work orders ──────────────────────────────────────────────────────────

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('workorders.raise', 'Work orders', 'Raise work orders',
   'Raise planned work on a property they manage — maintenance, an inspection finding, anything spotted on a walk-round — and optionally assign a contractor straight away. Separate from dispatching a request a tenant reported.',
   false, 15)
on conflict (key) do nothing;

CREATE OR REPLACE FUNCTION public.b7_grants(p_role user_role, p_capability text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
        when p_capability = 'tickets.assign_without_review' then false
        when p_capability = 'training.read' then false
        when p_capability = 'records.export' then false

        -- 0310. The Executive's own powers, as switches. Placed above the admin
        -- arm so an administrator is not shown holding two Executive-only
        -- powers that mean nothing for their role.
        when p_capability = 'requisitions.approve_within_limit' then p_role = 'operations_executive'
        when p_capability = 'operations.org_wide' then p_role = 'operations_executive'
        when p_capability = 'requisitions.raise' then p_role in (
          'fm_ops_staff', 'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        -- 0311. Raising planned work, split out of tickets.assign (dispatching a
        -- reported request) so the operator can switch one without the other.
        -- Baseline is exactly who held tickets.assign.
        when p_capability = 'workorders.raise' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'admin'
        )

        when p_role = 'admin' then true

        -- 0281. Placed ABOVE the role-specific arms deliberately: those arms are
        -- closed lists, and a capability added to the bottom of this CASE would
        -- never be reached for `executive`, `regional_manager` or either payment
        -- desk. The three confirmation desks are absent by intent, not omission
        -- — recording a claim disqualifies you from confirming it (0282's
        -- maker-checker), so granting it to a chain role hands them a way to
        -- take themselves out of the chain. `finance_approver` is the deliberate
        -- exception: taking a walk-in payment at the finance desk is the single
        -- commonest way one of these arrives, and the consequence — that a
        -- colleague must confirm it — is the control working, exactly as 0142
        -- says. 13 Sept 2026: unchanged by the board's reversal above — the
        -- Officer still takes the walk-in, the Approver still confirms it, and
        -- a walk-in the Officer takes is confirmed by someone else regardless.
        when p_capability = 'payments.record_offline' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager', 'finance_approver',
          'operations_executive'
        )

        -- 0307. The OEA Executive: org-wide sight of operations, dispatch and
        -- closure, and onboarding. Nothing financial beyond the requisitions
        -- the chain hands them (which is not a capability — decision 7), no
        -- structure (hierarchy, properties, leases), no vendor decisions, no
        -- export. Placed after `payments.record_offline`, which they do not
        -- hold: recording a claim is a confirmation desk's conflict.
        -- 0309: everything a facilities/properties/regional manager holds,
        -- organisation-wide, plus the org-wide reads 0307 gave. Bounded by
        -- `current_user_property_ids()`, which for the Executive is every
        -- property in their organisation.
        when p_role = 'operations_executive' then p_capability in (
          'tickets.read_all', 'tickets.triage_unassigned',
          'tickets.assign', 'tickets.close',
          'properties.read_all', 'assets.read', 'vendors.read',
          'bi.read', 'people.invite',
          'assets.write', 'assets.import',
          'vendors.write', 'vendors.evaluate', 'vendors.recommend', 'vendors.approve',
          'properties.write', 'units.assign_occupant', 'hierarchy.write',
          'applications.recommend', 'applications.approve',
          'sc.manage', 'leases.write'
        )

        when p_role = 'executive' then p_capability in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when p_role = 'payment_audit_approver' then p_capability in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        -- 0246, unchanged by 13 Sept 2026's reversal: the payment approver is
        -- the senior accounting desk and already held sc.manage before this
        -- migration. What moved is who else does.
        when p_role = 'payment_approver' then p_capability in (
          'vendors.read', 'bi.read', 'properties.read_all',
          'assets.read', 'sc.read_all', 'sc.manage'
        )

        when p_role = 'regional_manager' then p_capability in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.recommend', 'applications.approve',
          'hierarchy.write', 'sc.manage', 'leases.write',
          'vendors.recommend', 'vendors.approve'
        )

        when p_capability = 'tickets.read_all' then false

        when p_capability in ('assets.read', 'sc.read_all', 'properties.read_all')
          then p_role = 'finance_approver'

        when p_capability in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite', 'hierarchy.write',
                         'vendors.recommend',
                         'applications.recommend')
          then p_role in ('facility_manager', 'property_manager')

        when p_capability = 'vendors.read'
          then p_role in ('facility_manager', 'property_manager', 'finance_approver')

        -- 13 Sept 2026 (board). Was `p_role in ('finance_approver',
        -- 'property_manager')` since 0249. The Payment Officer's role narrows
        -- to disbursement; administering the service-charge budget and its
        -- apportionment is not part of "dispensing outward payments" and moves
        -- fully to the Approver, who already held it via the closed-list arm
        -- above. property_manager's own grant (0249) is untouched — every
        -- write it unlocks is still bounded to a property they hold.
        when p_capability = 'sc.manage'
          then p_role = 'property_manager'

        when p_capability = 'leases.write'
          then p_role = 'property_manager'

        when p_capability = 'bi.read'
          then p_role in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when p_capability = 'people.deactivate' then false
        when p_capability = 'tickets.triage_unassigned' then false

        else false
  end;
$function$;

-- Each org's existing tickets.assign choice, carried over role by role, before
-- the baseline seed fills anything not yet set.
insert into role_permissions (org_id, role, capability, granted, set_by, set_at)
select rp.org_id, rp.role, 'workorders.raise', rp.granted, rp.set_by, now()
  from role_permissions rp
 where rp.capability = 'tickets.assign'
on conflict (org_id, role, capability) do nothing;

do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.raise_work_order(p_property_id uuid, p_summary text, p_detail text DEFAULT NULL::text, p_category ticket_category DEFAULT 'maintenance'::ticket_category, p_urgency ticket_urgency DEFAULT 'normal'::ticket_urgency, p_asset_id uuid DEFAULT NULL::uuid, p_vendor_id uuid DEFAULT NULL::uuid, p_unit_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org  uuid := current_user_org_id();
  v_role user_role := current_user_role();
  v_id   uuid;
begin
  if v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;

  -- 0311. Its own switch in the matrix (Work orders), rather than riding on
  -- dispatch. Baseline: exactly the roles that held tickets.assign.
  if not has_permission('workorders.raise') then
    raise exception 'you do not have permission to raise work orders';
  end if;

  if length(trim(coalesce(p_summary, ''))) < 5 then
    raise exception 'describe the work in at least a few words';
  end if;

  if p_property_id is null
     or p_property_id not in (select current_user_property_ids()) then
    raise exception 'that property is not one you manage';
  end if;

  if p_asset_id is not null and not exists (
    select 1 from assets
     where id = p_asset_id and org_id = v_org and property_id = p_property_id
  ) then
    raise exception 'that asset is not on that property';
  end if;

  -- 0273. The same shape as the asset check two lines up: a unit on a
  -- different property is not a typo to silently correct, it is a claim about
  -- the wrong building.
  if p_unit_id is not null and not exists (
    select 1 from units
     where id = p_unit_id and org_id = v_org and property_id = p_property_id
  ) then
    raise exception 'that unit is not on that property';
  end if;

  insert into tickets (
    org_id, channel, sender_id, sender_role, property_id, unit_id, asset_id,
    message_text, summary, category, urgency, status, requires_human_review,
    reviewed_at, reviewed_by
  ) values (
    v_org, 'portal',
    -- ⚠️ WAS `null`, and that is why an FM/PM could not find work they raised
    -- themselves. `tickets_select` returns a request to `sender_id = auth.uid()`
    -- and the "Raised by me" view filters on it, so a work order with no sender
    -- belonged to nobody: its raiser could not see it unless they were also
    -- assigned it or managed the property. The board asked for exactly this
    -- view (decision 23) and it was empty for the one path that fills it.
    --
    -- 0120's reasoning for NULL was that planned work "has no reporter", which
    -- is true of a TENANT and false of a raiser. `app/dashboard/new/actions.ts`
    -- has always stamped whoever submitted the form, FM included, so a
    -- staff-raised request already carried a sender by the other route — this
    -- was the inconsistent one.
    auth.uid(), v_role,
    p_property_id, p_unit_id, p_asset_id,
    coalesce(nullif(trim(coalesce(p_detail, '')), ''), trim(p_summary)),
    trim(p_summary), p_category, p_urgency, 'open',
    false,
    now(), auth.uid()           -- raised deliberately by someone who may dispatch: reviewed
  )
  returning id into v_id;

  if p_vendor_id is not null then
    if not exists (select 1 from vendors where id = p_vendor_id and org_id = v_org) then
      raise exception 'that contractor is not on this organisation';
    end if;

    update tickets
       set assigned_vendor_id = p_vendor_id,
           assigned_by = auth.uid(),
           assigned_at = now(),
           status = 'assigned'
     where id = v_id;

    perform notify_user(
      v.user_id, 'assignment', 'A job has been assigned to you',
      'Open it to acknowledge and get started.',
      '/dashboard/tickets/' || v_id::text, 'ticket', v_id
    )
    from vendors v
    where v.id = p_vendor_id and v.user_id is not null;
  end if;

  return v_id;
end;
$function$;

-- ── 2. A refused payout can be sent again ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_vendor_remittance(p_payment_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  pay payments%rowtype;
  v_recipient uuid;
  v_id uuid;
  v_live remittance_status;
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

  -- The chain, at the amount now being sent. `approved_at` says the chain
  -- completed once; this says it completed for THIS number.
  perform assert_chain_cleared('vendor_payment', pay.id, pay.amount);

  perform assert_may_disburse(p_executed_by, pay.org_id);

  -- Maker-checker on the recorded approver (0142) …
  if pay.approved_by = p_executed_by then
    raise exception 'the person who approved this payment cannot also send it — someone else must release the money';
  end if;

  -- … and on EVERY stage, not only the last one. 0142 compared against
  -- `approved_by` alone, which since 0151 is the stage-3 approver. The FM who
  -- signed the job off and the auditor who verified it are equally people who
  -- must not also be the ones moving the money.
  if exists (
    select 1 from payment_approvals a
     where a.payable_type = 'vendor_payment'
       and a.payable_id   = pay.id
       and a.actor_id     = p_executed_by
  ) then
    raise exception 'you approved this payment at an earlier stage and cannot also send it — someone else must release the money';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = pay.org_id and party = 'vendor' and vendor_id = pay.vendor_id
     and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method)
   limit 1;
  if v_recipient is null then
    raise exception '%', case when p_method = 'manual'
      then 'no confirmed bank-transfer account is on file for this vendor — ask them for their bank details, or use the account on their approved registration'
      else 'no verified bank recipient is on file for this vendor' end;
  end if;

  -- 0311. A remittance created by an earlier click that never reached the
  -- gateway — refused before its claim (no Paystack account connected, a
  -- recipient on the shared platform account) — used to stay `queued` and hold
  -- `remittances_one_live_per_payment_uidx`, so every later attempt, by either
  -- route, died on a raw duplicate-key error. Nothing left the account on it:
  -- `queued` is by definition unclaimed, and the claim takes the row lock, so
  -- a send in progress is `sending`, not `queued`. It is closed as failed with
  -- the reason, and this attempt takes its place.
  update remittances
     set status = 'failed',
         gateway_message = 'superseded before sending — nothing left the account'
   where payment_id = pay.id and status = 'queued';

  select status into v_live from remittances
   where payment_id = pay.id and status <> 'failed'
   limit 1;
  if v_live = 'sent' then
    raise exception 'this payment has already been sent — open it from Remittances to see the advice';
  elsif v_live in ('sending', 'unknown') then
    raise exception 'a payout for this payment is already on its way or waiting to be reconciled (%) — check it under Remittances before sending again', v_live;
  elsif v_live = 'reversed' then
    raise exception 'the payout for this payment was reversed — it needs reconciling before it can be sent again';
  end if;

  perform recognise_vendor_payable(pay.id);

  insert into remittances (
    org_id, party, recipient_id, payment_id,
    gross_amount, management_fee, admin_fee, net_amount,
    reference, approved_by, approved_at, created_by
  ) values (
    pay.org_id, 'vendor', v_recipient, pay.id,
    pay.amount, 0, 0, pay.amount,
    p_reference, pay.approved_by, pay.approved_at, p_executed_by
  )
  returning id into v_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_requisition_vendor_remittance(p_requisition_id uuid, p_vendor_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method)
   limit 1;
  if v_recipient is null then
    raise exception '%', case when p_method = 'manual'
      then 'no confirmed bank-transfer account is on file for this vendor — ask them for their bank details, or use the account on their approved registration'
      else 'no verified bank recipient is on file for this vendor' end;
  end if;

  -- 0311. Lines held by a payout that never left: one refused before its
  -- claim (still `queued`) or one that failed. Both used to keep the lines
  -- bound, so they showed as settled and nothing could ever send them. The
  -- queued one is closed as failed — nothing was sent on it — and every line
  -- bound to a failed payout for this vendor is released to be sent again.
  update remittances r
     set status = 'failed',
         gateway_message = 'superseded before sending — nothing left the account'
   where r.status = 'queued'
     and r.id in (select l.remittance_id from ops_requisition_lines l
                   where l.requisition_id = req.id and l.vendor_id = p_vendor_id);
  update ops_requisition_lines l
     set remittance_id = null
   where l.requisition_id = req.id and l.vendor_id = p_vendor_id
     and l.remittance_id in (select r.id from remittances r where r.status = 'failed');

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
$function$;

CREATE OR REPLACE FUNCTION public.create_requisition_payee_remittance(p_requisition_id uuid, p_payee_recipient_id uuid, p_reference text, p_executed_by uuid, p_method text DEFAULT 'gateway'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     and active and payout_account_usable(gateway, recipient_code, verified_at, evidence_path, p_method);
  if v_recipient.id is null then
    raise exception '%', case when p_method = 'manual'
      then 'that payee has not sent bank details that have been confirmed yet'
      else 'that payee has no verified bank recipient on file' end;
  end if;

  -- 0311. Lines held by a payout that never left: one refused before its
  -- claim (still `queued`) or one that failed. Both used to keep the lines
  -- bound, so they showed as settled and nothing could ever send them. The
  -- queued one is closed as failed — nothing was sent on it — and every line
  -- bound to a failed payout for this payee is released to be sent again.
  update remittances r
     set status = 'failed',
         gateway_message = 'superseded before sending — nothing left the account'
   where r.status = 'queued'
     and r.id in (select l.remittance_id from ops_requisition_lines l
                   where l.requisition_id = req.id and l.payee_recipient_id = p_payee_recipient_id);
  update ops_requisition_lines l
     set remittance_id = null
   where l.requisition_id = req.id and l.payee_recipient_id = p_payee_recipient_id
     and l.remittance_id in (select r.id from remittances r where r.status = 'failed');

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
$function$;

-- ── 3. Assertions ───────────────────────────────────────────────────────────
do $$
begin
  if exists (
    select 1 from role_permissions a
      join role_permissions b on b.org_id = a.org_id and b.role = a.role
     where a.capability = 'tickets.assign' and b.capability = 'workorders.raise'
       and a.granted <> b.granted
  ) then
    raise exception '0311: workorders.raise must start exactly where tickets.assign is';
  end if;
  if position('workorders.raise' in pg_get_functiondef('raise_work_order'::regproc)) = 0 then
    raise exception '0311: raise_work_order must check workorders.raise';
  end if;
end $$;
