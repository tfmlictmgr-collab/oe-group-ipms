-- The last hard-wired manager actions follow their switches
-- (requested 3 Oct 2026).
--
-- Five actions checked a fixed role list and nothing in the operator's
-- permission matrix, so a switch that looked like it governed them did not:
--
--   archive_asset / restore_asset   FM/PM branch now also needs assets.write
--   submit_vendor_evaluation        FM/PM branch now also needs vendors.evaluate
--   resubmit_returned_payable       resending a requisition needs
--                                   requisitions.raise (an administrator is exempt)
--   set_property_application_state  new capability applications.open_close
--                                   (Lettings), baseline admin + executive —
--                                   exactly the two roles it named before
--
-- Every baseline already holds the switch it now asks for, so applying this
-- changes nobody's access; it only makes the switches mean what they say.
--
-- Deliberately NOT switches: asking a contractor or landlord for bank details
-- (where money goes — decision 7 keeps it hard-wired to the payment officer
-- and administrator), and resending a returned vendor INVOICE (the payment
-- officer's desk, the same). offer_vendor_introduction is the vendor's own act.
--
-- Rebuilt from pg_get_functiondef of a database holding 0001–0312.

set local lock_timeout = '5s';

insert into capabilities (key, module, label, description, locked, sort_order) values
  ('applications.open_close', 'Lettings', 'Open or close a property for applications',
   'Override whether a property is taking tenancy applications — keep a waiting list on a full building, or close one being refurbished. The override is recorded against the person.',
   false, 89)
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

        -- 0312. Verifying the service on a vendor invoice and running its
        -- performance check — the first two steps of the payment gate. Baseline
        -- is every role the invoice screen offered those buttons to.
        when p_capability = 'payments.verify_service' then p_role in (
          'facility_manager', 'property_manager', 'regional_manager',
          'operations_executive', 'finance_approver', 'admin'
        )

        -- 0313. Opening or closing a property's tenancy applications.
        -- Baseline: exactly the two roles set_property_application_state named.
        when p_capability = 'applications.open_close' then p_role in ('admin', 'executive')

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

CREATE OR REPLACE FUNCTION public.archive_asset(p_asset_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
  v_property uuid;
  v_role user_role := current_user_role();
begin
  select org_id, property_id into v_org, v_property
  from assets where id = p_asset_id and deleted_at is null;

  if v_org is null then
    raise exception 'asset not found or already archived';
  end if;

  -- Same org as the caller, always.
  if v_org is distinct from current_user_org_id() then
    raise exception 'asset belongs to another organisation';
  end if;

  -- Admin org-wide; FM/PM only on properties they are staked to.
  if not (
    v_role = 'admin'
    or (v_role = any (fm_roles())
        -- 0313. The asset-editing switch governs this too.
        and has_permission('assets.write')
        and v_property in (select current_user_property_ids()))
  ) then
    raise exception 'only an administrator or the managing FM/PM may archive this asset';
  end if;

  -- Fires audit_asset_write, so archiving is recorded like any other change.
  update assets set deleted_at = now() where id = p_asset_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.restore_asset(p_asset_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
  v_property uuid;
  v_tag text;
  v_role user_role := current_user_role();
begin
  select org_id, property_id, asset_tag into v_org, v_property, v_tag
  from assets where id = p_asset_id and deleted_at is not null;

  if v_org is null then
    raise exception 'archived asset not found';
  end if;

  if v_org is distinct from current_user_org_id() then
    raise exception 'asset belongs to another organisation';
  end if;

  if not (
    v_role = 'admin'
    or (v_role = any (fm_roles())
        -- 0313. The asset-editing switch governs this too.
        and has_permission('assets.write')
        and v_property in (select current_user_property_ids()))
  ) then
    raise exception 'only an administrator or the managing FM/PM may restore this asset';
  end if;

  -- The unique tag index ignores archived rows, so the tag may have been reused
  -- while this asset was archived. Refuse rather than silently create a clash.
  if exists (
    select 1 from assets
    where org_id = v_org and lower(asset_tag) = lower(v_tag)
      and deleted_at is null and id <> p_asset_id
  ) then
    raise exception 'asset tag % is now in use by an active asset', v_tag;
  end if;

  update assets set deleted_at = null where id = p_asset_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_vendor_evaluation(p_ticket_id uuid, p_source text, p_responses jsonb, p_comment text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t tickets%rowtype;
  v_org uuid;
  v_vendor uuid;
  v_eval uuid;
  v_dims eval_dimension[];
  v_line jsonb;
  crit evaluation_criteria%rowtype;
  v_points numeric;
  v_quality numeric; v_compliance numeric; v_satisfaction numeric;
  v_response numeric; v_completion numeric;
  -- 0271's genuine addition: the evaluator's own words, which explain a score
  -- and never change one — the composite stays the rubric.
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  -- Deactivation guard. Null-safe by construction: current_user_is_active()
  -- returns a boolean from exists(), never NULL, and the auth.uid() test keeps
  -- the service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;

  if p_source not in ('tenant', 'fm_pm') then
    raise exception 'unknown evaluation source: %', p_source;
  end if;

  if v_comment is not null and length(v_comment) > 2000 then
    raise exception 'that comment is too long — keep it under 2000 characters';
  end if;

  select * into t from tickets where id = p_ticket_id;
  if t.id is null then raise exception 'that request could not be found'; end if;
  v_org := t.org_id;
  v_vendor := t.assigned_vendor_id;

  if v_vendor is null then
    raise exception 'this request has no vendor assigned — nothing to evaluate';
  end if;
  if t.status not in ('resolved', 'closed') then
    raise exception 'this request has not been completed yet';
  end if;

  -- Standing to evaluate. Checked here, not left to RLS, because the two
  -- sources have entirely different authority rules and bundling them with the
  -- scoring keeps "who may say what" and "what did they say" from drifting
  -- apart the way two independently-maintained checks eventually do.
  if auth.uid() is not null then
    if p_source = 'tenant' then
      if t.sender_id is distinct from auth.uid() then
        raise exception 'only the person who raised this request may rate it';
      end if;
      -- ⚠️ AND they must actually be a tenant (0220).
      --
      -- Standing for a TENANT-source rating was "you are the sender", which was
      -- a safe proxy only while a sender was always a tenant. It is not:
      -- `New Request` has always stamped whoever submitted the form, and since
      -- 0218 `raise_work_order` stamps the FM/PM who raised the job. Without
      -- this line an FM could file the SATISFACTION half of the rubric on their
      -- own work order — a contractor's tenant score, written by the person who
      -- commissioned the work, feeding the composite that gates payment.
      --
      -- The proxy is replaced by the thing it was standing in for. The FM's own
      -- half (quality/compliance) is unaffected and is what the screen now
      -- offers them.
      if current_user_role() is distinct from 'tenant' then
        raise exception
          'the satisfaction rating belongs to the tenant who reported this — rate the quality of the work instead';
      end if;
    else
      if not (
        current_user_role() = any (oversight_roles())
        or (current_user_role() = any (fm_roles())
            -- 0313. The vendor-evaluation switch, which this never asked.
            and has_permission('vendors.evaluate')
            and v_vendor in (select current_user_scoped_vendor_ids()))
      ) then
        raise exception 'you do not have permission to evaluate this vendor';
      end if;
    end if;
  end if;

  if exists (
    select 1 from vendor_evaluations
     where ticket_id = p_ticket_id and source = p_source
  ) then
    raise exception 'this % evaluation has already been submitted for this request', p_source;
  end if;

  v_dims := case p_source
    when 'tenant' then array['satisfaction']::eval_dimension[]
    else array['quality', 'compliance']::eval_dimension[]
  end;

  -- Refuse rather than silently score zero. An org with no rubric configured
  -- for this source has no meaningful answer to "how did they do" — a 0/100
  -- would look exactly like a genuinely bad review, not like a missing setup
  -- step.
  if not exists (
    select 1 from evaluation_criteria
     where org_id = v_org and active and dimension = any (v_dims) and measure = 'manual'
  ) then
    raise exception 'the evaluation rubric has not been set up for this organisation yet';
  end if;

  insert into vendor_evaluations (org_id, vendor_id, ticket_id, source, evaluated_by, comment)
  values (v_org, v_vendor, p_ticket_id, p_source, auth.uid(), v_comment)
  returning id into v_eval;

  -- ⚠️ Two answers to one question is not an answer. The loop below reads
  -- ONE response per criterion with `limit 1` and no `order by`, so a payload
  -- naming the same criterionId twice scored whichever row the executor
  -- happened to return -- on a composite that gates a vendor payment (B4: no
  -- payment without performance validation). Refused rather than de-duplicated,
  -- for 0225's reason: two contradictory statements about one fact, and only
  -- the person submitting them knows which is right.
  --
  -- 📌 0234 added this and 0271 deleted it without noticing. Restored here.
  if exists (
    select 1 from jsonb_array_elements(p_responses) e
     where e ? 'criterionId'
     group by (e->>'criterionId')
    having count(*) > 1
  ) then
    raise exception
      'that evaluation answers the same criterion more than once; each criterion takes one response'
      using errcode = '22023';
  end if;

  -- ── Manual dimensions: one response per active criterion, points from the
  --    fixed value→fraction mapping for its response_type. ─────────────────
  for crit in
    select * from evaluation_criteria
     where org_id = v_org and active and dimension = any (v_dims) and measure = 'manual'
     order by sort_order
  loop
    v_line := null;
    select value_obj into v_line from (
      select jsonb_array_elements(p_responses) as value_obj
    ) x
    where (value_obj->>'criterionId')::uuid = crit.id
    limit 1;

    if v_line is null then
      raise exception 'missing a response for: %', crit.label;
    end if;

    v_points := crit.max_points * case
      when crit.response_type = 'met_partial_not_met' then
        case v_line->>'value'
          when 'met' then 1.0 when 'partial' then 0.5 when 'not_met' then 0.0
          else null end
      when crit.response_type = 'yes_no' then
        case v_line->>'value' when 'yes' then 1.0 when 'no' then 0.0 else null end
      when crit.response_type = 'scale_1_5' then
        case v_line->>'value'
          when '1' then 0.0 when '2' then 0.25 when '3' then 0.5
          when '4' then 0.75 when '5' then 1.0 else null end
    end;

    if v_points is null then
      raise exception 'not a valid response for "%": %', crit.label, v_line->>'value';
    end if;

    insert into evaluation_responses (org_id, evaluation_id, criterion_id, response_value, points_awarded)
    values (v_org, v_eval, crit.id, v_line->>'value', v_points);
  end loop;

  -- Dimension score = the sum of points actually awarded. The seed rubric
  -- makes each manual dimension's max_points sum to 100 by construction, so no
  -- further scaling is needed — an admin who edits the rubric to sum to
  -- something else is choosing a scale, and the score is that scale.
  if p_source = 'tenant' then
    select coalesce(sum(er.points_awarded), 0) into v_satisfaction
      from evaluation_responses er where er.evaluation_id = v_eval;
    update vendor_evaluations set satisfaction_score = v_satisfaction where id = v_eval;
  else
    select coalesce(sum(er.points_awarded) filter (where ec.dimension = 'quality'), 0),
           coalesce(sum(er.points_awarded) filter (where ec.dimension = 'compliance'), 0)
      into v_quality, v_compliance
      from evaluation_responses er join evaluation_criteria ec on ec.id = er.criterion_id
     where er.evaluation_id = v_eval;

    -- ── Auto dimensions: computed from the ticket's own timestamps, against
    --    the SLA target that was ACTIVE when the ticket resolved — a
    --    criterion superseded since then must not reach back and change a
    --    score already given. Linear taper: on-target = 100, double the
    --    target or worse = 0.
    --
    -- ⚠️ Falls back to the EARLIEST version of the criterion when none was yet
    -- active at resolution time, rather than leaving the dimension null
    -- forever. Without this, every ticket resolved in the gap between "Day 11
    -- shipped" and "an admin got around to setting up the rubric" — which is
    -- not a hypothetical, it is exactly what a fresh org does on day one —
    -- could NEVER be auto-scored, because no criterion would ever satisfy
    -- `effective_from <= resolved_at`. The rubric that eventually gets set up
    -- is the best available answer to "what was the target", even for a job
    -- that finished slightly before it existed on paper.
    select * into crit from evaluation_criteria
     where org_id = v_org and dimension = 'response' and effective_from <= coalesce(t.resolved_at, now())
     order by effective_from desc limit 1;
    if crit.id is null then
      select * into crit from evaluation_criteria
       where org_id = v_org and dimension = 'response'
       order by effective_from asc limit 1;
    end if;
    if crit.id is not null and t.first_response_at is not null then
      v_response := greatest(0, least(100,
        100 * (2 - extract(epoch from (t.first_response_at - t.created_at)) / 3600.0 / crit.sla_target_hours)
      ));
    end if;

    select * into crit from evaluation_criteria
     where org_id = v_org and dimension = 'completion' and effective_from <= coalesce(t.resolved_at, now())
     order by effective_from desc limit 1;
    if crit.id is null then
      select * into crit from evaluation_criteria
       where org_id = v_org and dimension = 'completion'
       order by effective_from asc limit 1;
    end if;
    if crit.id is not null and t.resolved_at is not null then
      v_completion := greatest(0, least(100,
        100 * (2 - extract(epoch from (t.resolved_at - t.created_at)) / 3600.0 / crit.sla_target_hours)
      ));
    end if;

    update vendor_evaluations
       set quality_score = v_quality, compliance_score = v_compliance,
           response_score = v_response, completion_score = v_completion
     where id = v_eval;
  end if;

  return v_eval;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_property_application_state(p_property_id uuid, p_state text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  p properties%rowtype;
  v_caller uuid := auth.uid();
begin
  if p_state not in ('auto', 'open', 'closed') then
    raise exception 'unknown application state %', p_state;
  end if;

  select * into p from properties where id = p_property_id and deleted_at is null;
  if p.id is null then
    raise exception 'that property does not exist';
  end if;

  -- Definer function, so the caller's org and privilege are checked HERE. B7
  -- gives configuring intake to an administrator; a regional manager runs the
  -- properties they are assigned, not the decision to take applicants at all.
  if v_caller is not null then
    if p.org_id is distinct from current_user_org_id() then
      raise exception 'that property belongs to another organisation';
    end if;
    -- 0313. A switch in the matrix (Lettings); baseline is the two roles this
    -- named before — administrator and executive.
    if not has_permission('applications.open_close') then
      raise exception 'opening or closing applications for a property is switched off for your role';
    end if;
  end if;

  update properties
     set applications_state = p_state,
         applications_state_note = nullif(trim(coalesce(p_note, '')), ''),
         applications_state_set_by = v_caller,
         applications_state_set_at = now()
   where id = p_property_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p.org_id, v_caller, 'property.application_state', 'property', p.id,
          jsonb_build_object('state', p.applications_state),
          jsonb_build_object('state', p_state, 'note', p_note));
end;
$function$;

CREATE OR REPLACE FUNCTION public.resubmit_returned_payable(p_payable_type text, p_payable_id uuid, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid;
  v_may boolean := false;
  v_prop uuid;
begin
  if p_payable_type = 'ops_requisition' then
    select r.org_id into v_org from ops_requisitions r where r.id = p_payable_id;
    if v_org is null then raise exception 'requisition not found'; end if;
    if v_org is distinct from current_user_org_id() then
      raise exception 'that requisition belongs to another organisation';
    end if;

    v_prop := payable_property_id('ops_requisition', p_payable_id);
    select (
      current_user_role() = 'admin'
      -- 0313. Resending is raising again, so the raise switch governs it.
      or (has_permission('requisitions.raise') and (
            r.raised_by = auth.uid()
            or (current_user_role() = any (fm_roles())
                and v_prop in (select current_user_property_ids()))))
    ) into v_may
      from ops_requisitions r where r.id = p_payable_id;

    if not coalesce(v_may, false) then
      raise exception 'only the person who raised this requisition, a manager of its property, or an administrator may resend it';
    end if;

    update ops_requisitions
       set status = 'pending_approval', returned_at = null
     where id = p_payable_id
       and status = 'returned_for_correction';
    if not found then
      raise exception 'that requisition is not waiting to be corrected';
    end if;

  elsif p_payable_type = 'vendor_payment' then
    select p.org_id into v_org from payments p where p.id = p_payable_id;
    if v_org is null then raise exception 'payment not found'; end if;
    if v_org is distinct from current_user_org_id() then
      raise exception 'that payment belongs to another organisation';
    end if;
    if current_user_role() not in ('finance_approver', 'admin') then
      raise exception 'only the payment officer or an administrator may resend a returned invoice';
    end if;

    update payments
       set status = 'recommended', returned_at = null
     where id = p_payable_id
       and status = 'returned_for_correction';
    if not found then
      raise exception 'that invoice is not waiting to be corrected';
    end if;

  else
    raise exception 'unknown payable type %', p_payable_type;
  end if;

  -- Clear the outstanding return so stage 1 has a free slot to decide into.
  update payment_approvals a
     set superseded_at = now()
   where a.payable_type  = p_payable_type
     and a.payable_id    = p_payable_id
     and a.decision      = 'returned'
     and a.superseded_at is null;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'payment.resubmitted_after_return',
    case p_payable_type when 'ops_requisition' then 'ops_requisitions' else 'payments' end,
    p_payable_id,
    jsonb_build_object('status', 'returned_for_correction'),
    jsonb_build_object('resubmitted_at', now(), 'note', p_note)
  );
end;
$function$;

do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

do $$
begin
  if position('assets.write' in pg_get_functiondef('archive_asset'::regproc)) = 0
     or position('assets.write' in pg_get_functiondef('restore_asset'::regproc)) = 0
     or position('vendors.evaluate' in pg_get_functiondef('submit_vendor_evaluation'::regproc)) = 0
     or position('applications.open_close' in pg_get_functiondef('set_property_application_state'::regproc)) = 0
     or position('requisitions.raise' in pg_get_functiondef('resubmit_returned_payable'::regproc)) = 0 then
    raise exception '0313: a rebuilt function lost its switch';
  end if;
end $$;
