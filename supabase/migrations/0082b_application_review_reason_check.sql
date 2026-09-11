-- `application_decisions.reason` had a table CHECK and no friendly message ahead
-- of it, unlike `operator_actions.reason` (0079) which raises its own exception
-- before the insert. Matching that pattern rather than letting a caller hit a
-- raw constraint-violation error.

create or replace function record_application_recommendation(
  p_application_id uuid, p_approve boolean, p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;
  if not (select has_permission('applications.recommend')) then
    raise exception 'you do not hold applications.recommend';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status not in ('submitted', 'under_review') then
    raise exception 'this application is not awaiting a recommendation';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id,
          case when p_approve then 'recommend_approve' else 'recommend_reject' end,
          auth.uid(), p_reason);

  update tenant_applications
     set status = 'under_review',
         recommendation = case when p_approve then 'approve' else 'reject' end,
         recommended_by = auth.uid(),
         recommended_at = now()
   where id = a.id;
end;
$$;

create or replace function record_application_info_request(
  p_application_id uuid, p_reason text, p_token_hash text, p_expires_at timestamptz
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;
  if not (
    (select has_permission('applications.recommend'))
    or (select has_permission('applications.approve'))
  ) then
    raise exception 'you do not hold review or approval rights';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status not in ('submitted', 'under_review') then
    raise exception 'this application is not open for a request';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id, 'request_info', auth.uid(), p_reason);

  update tenant_applications
     set status = 'info_requested',
         resume_token_hash = p_token_hash,
         resume_expires_at = p_expires_at
   where id = a.id;
end;
$$;

create or replace function record_application_approval(
  p_application_id uuid, p_reason text, p_invite_token_hash text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  v_required  integer;
  v_approvals integer;
  v_invite_id uuid;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;
  if not (select has_permission('applications.approve')) then
    raise exception 'you do not hold applications.approve';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status <> 'under_review' then
    raise exception 'this application has not been recommended by a first reviewer yet';
  end if;
  if a.recommended_by = auth.uid() then
    raise exception 'the person who recommended an application may not also approve it';
  end if;
  if exists (
    select 1 from application_decisions
     where application_id = a.id and kind = 'approve' and decided_by = auth.uid()
  ) then
    raise exception 'you have already approved this application';
  end if;
  if a.unit_id is null then
    raise exception 'assign a unit to this application before approving it';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id, 'approve', auth.uid(), p_reason);

  v_required := case when a.type = 'corporate' then 2 else 1 end;
  select count(distinct decided_by) into v_approvals
    from application_decisions where application_id = a.id and kind = 'approve';

  if v_approvals < v_required then
    return null;
  end if;

  if p_invite_token_hash is null then
    raise exception 'this approval completes the application and needs an invitation token';
  end if;

  insert into invitations (org_id, email, role, full_name, unit_id, token_hash, invited_by, expires_at)
  values (a.org_id, a.applicant_email, 'tenant', a.applicant_name, a.unit_id,
          p_invite_token_hash, auth.uid(), now() + interval '14 days')
  returning id into v_invite_id;

  update tenant_applications
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), decision_notes = p_reason
   where id = a.id;

  return v_invite_id;
end;
$$;

create or replace function record_application_rejection(
  p_application_id uuid, p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then raise exception 'no such application'; end if;
  if not (select has_permission('applications.approve')) then
    raise exception 'you do not hold applications.approve';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status <> 'under_review' then
    raise exception 'this application has not been recommended by a first reviewer yet';
  end if;
  if a.recommended_by = auth.uid() then
    raise exception 'the person who recommended an application may not also decide it';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id, 'reject', auth.uid(), p_reason);

  update tenant_applications
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
         decision_notes = p_reason, purge_after = now() + interval '90 days'
   where id = a.id;
end;
$$;
