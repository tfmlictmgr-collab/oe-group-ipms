-- Day 8 — two-tier human review, and only human review.
--
-- Locked decisions 2 and 10: a PM/FM recommends, an approver decides
-- independently, and no automated system may decide, score, rank or recommend.
-- Individual applications need one approver; corporate need TWO, and they must
-- be two different people. The recommender may never also be an approver —
-- maker-checker, the same separation of duties already enforced on money.
--
-- The full history of who did what and why lives in `application_decisions`,
-- mirroring `ticket_messages` (0075): one append-only table rather than
-- overloading `tenant_applications.status` with a state per possible actor.
-- `tenant_applications` keeps a denormalised `recommendation` for the queue to
-- sort and filter on without a join, exactly as `tickets.urgency_source` was
-- added for the same reason.

-- ── The decision trail ──────────────────────────────────────────────────────
create type application_decision_kind as enum (
  'recommend_approve', 'recommend_reject', 'request_info', 'approve', 'reject'
);

create unique index if not exists tenant_applications_id_org_uidx
  on tenant_applications (id, org_id);

create table application_decisions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references orgs(id) on delete cascade,
  application_id uuid not null references tenant_applications(id) on delete cascade,
  kind           application_decision_kind not null,
  decided_by     uuid not null references users(id),
  -- Locked decision 10: "the reviewer must state their own reason". Not a
  -- checkbox, not optional, and long enough to be a reason rather than a word.
  reason         text not null check (length(trim(reason)) >= 10),
  created_at     timestamptz not null default now(),

  constraint application_decisions_app_same_org_fk
    foreign key (application_id, org_id) references tenant_applications (id, org_id)
);

create index application_decisions_app_idx on application_decisions (application_id, created_at);

alter table application_decisions enable row level security;

-- Visible to exactly whoever may see the application. Delegating to
-- `tenant_applications` rather than restating its predicate is the same
-- discipline as `ticket_messages` — the two can never drift apart.
create policy application_decisions_select on application_decisions for select to authenticated
  using (application_id in (select id from tenant_applications));

-- No write policy. Every write carries a state-machine check and a maker-checker
-- rule that belong together in one function, not split between a policy and a
-- server action — that split is exactly how the Day 7 document gate went missing.

-- ── The queue's own columns ─────────────────────────────────────────────────
alter table tenant_applications
  add column if not exists recommendation   text check (recommendation in ('approve', 'reject')),
  add column if not exists recommended_by   uuid references users(id),
  add column if not exists recommended_at   timestamptz;

comment on column tenant_applications.recommendation is
  'The tier-1 reviewer''s recommendation. Never binding on tier 2 — an approver may decide either way regardless, which is the point of an independent second check rather than a rubber stamp.';

-- ── Two capabilities, unlocked and matrix-configurable ──────────────────────
insert into capabilities (key, module, label, description, locked, sort_order) values
  ('applications.recommend', 'Lettings', 'Recommend applications',
   'First-tier review: read an application''s documents and recommend approval or rejection, or ask the applicant for more information. Never a final decision.',
   false, 91),
  ('applications.approve', 'Lettings', 'Approve or reject applications',
   'Second-tier, independent decision. Requires a stated reason and can never be the same person who recommended it.',
   false, 92)
on conflict (key) do nothing;

create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager']::user_role[]
    loop
      v_granted := case
        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned',
          'applications.review_all', 'applications.approve'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read', 'applications.recommend'
        )

        when cap.key in ('tickets.read_all', 'assets.read',
                         'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r = 'facility_manager'

        when cap.key = 'vendors.read' then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        -- Tier 1: the property-operational roles. Tier 2: the roles that already
        -- hold independent sign-off over money — the same separation of duties.
        when cap.key = 'applications.recommend' then r = 'facility_manager'
        when cap.key = 'applications.approve'    then r = 'finance_approver'

        -- B7 silent → OFF.
        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- Backfill the two new capabilities into every existing org's matrix — the seed
-- function only inserts, and an org created before this migration would
-- otherwise never see the row at all, granted or not.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end $$;

-- ── Assigning the unit ──────────────────────────────────────────────────────
--
-- The public form captures a PROPERTY; most prospects do not know a unit number.
-- A reviewer assigns the specific vacant unit during review, and final approval
-- requires one — you cannot complete a tenancy decision without knowing which
-- unit it is for.
create or replace function assign_application_unit(p_application_id uuid, p_unit_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  u units%rowtype;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null;
  if a.id is null then
    raise exception 'no such application';
  end if;
  if not (
    (select has_permission('applications.review_all'))
    or a.property_id in (select current_user_property_ids())
  ) then
    raise exception 'you may not act on this application';
  end if;
  if a.status not in ('submitted', 'under_review', 'info_requested') then
    raise exception 'this application is no longer open for review';
  end if;

  select * into u from units where id = p_unit_id and org_id = a.org_id;
  if u.id is null then
    raise exception 'no such unit';
  end if;
  if u.property_id is distinct from a.property_id then
    raise exception 'that unit does not belong to the property this application is for';
  end if;
  if u.occupant_user_id is not null then
    raise exception 'that unit already has an occupant';
  end if;

  update tenant_applications set unit_id = p_unit_id where id = a.id;
end;
$$;

revoke all on function assign_application_unit(uuid, uuid) from public;
grant execute on function assign_application_unit(uuid, uuid) to authenticated, service_role;

-- ── Tier 1: recommend ───────────────────────────────────────────────────────
create or replace function record_application_recommendation(
  p_application_id uuid,
  p_approve        boolean,
  p_reason         text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then
    raise exception 'no such application';
  end if;
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

revoke all on function record_application_recommendation(uuid, boolean, text) from public;
grant execute on function record_application_recommendation(uuid, boolean, text) to authenticated, service_role;

comment on function record_application_recommendation is
  'Tier 1. Never binding on tier 2 by itself — recorded so an approver can see it, and can still decide either way.';

-- ── Ask the applicant for more ─────────────────────────────────────────────
--
-- Either tier may ask. Mints a NEW resume token exactly as `start_tenant_application`
-- did — the original was deliberately killed at submission so an application
-- under review could not be edited behind the reviewer's back; asking for more
-- information is the one door that reopens, on a fresh token so an old, possibly
-- leaked link cannot resurrect a decided application later.
create or replace function record_application_info_request(
  p_application_id uuid,
  p_reason         text,
  p_token_hash     text,
  p_expires_at     timestamptz
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then
    raise exception 'no such application';
  end if;
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

revoke all on function record_application_info_request(uuid, text, text, timestamptz) from public;
grant execute on function record_application_info_request(uuid, text, text, timestamptz) to authenticated, service_role;

-- ── Resubmission also reopens from `info_requested` ────────────────────────
--
-- The applicant's answers may have changed everything a recommendation was
-- based on, so a stale one must not silently carry forward — a resubmission
-- clears it and starts tier 1 again, exactly as a first submission does.
create or replace function submit_tenant_application(
  p_token_hash text,
  p_form       jsonb,
  p_sensitive  jsonb,
  p_consent    text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  v_missing text;
begin
  select * into a from tenant_applications
   where resume_token_hash = p_token_hash
     and status in ('draft', 'info_requested')
     and resume_expires_at > now()
     and purged_at is null
   for update;

  if a.id is null then
    raise exception 'this application link is no longer valid';
  end if;
  if coalesce(trim(p_consent), '') = '' then
    raise exception 'consent must be recorded before an application is accepted';
  end if;

  select string_agg(r.label, ', ' order by r.sort_order) into v_missing
    from application_document_requirements r
   where r.org_id = a.org_id
     and r.type = a.type
     and r.required
     and not exists (
       select 1 from application_attachments t
        where t.application_id = a.id and t.kind = r.kind
     );

  if v_missing is not null then
    raise exception 'Still to upload: %', v_missing;
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb),
         status = 'submitted',
         submitted_at = now(),
         consent_given_at = now(),
         consent_statement = p_consent,
         resume_token_hash = null,
         -- A resubmission answers whatever prompted the request; the old
         -- recommendation was made against the version before it.
         recommendation = null,
         recommended_by = null,
         recommended_at = null
   where id = a.id;

  return a.id;
end;
$$;

-- ── Tier 2: the independent decision ────────────────────────────────────────
--
-- `p_invite_token_hash` is optional and used only on the approval that
-- completes the application: the caller (a Next.js server action) generates the
-- raw token the SAME way `inviteMember` does — `generateInviteToken()` /
-- `hashInviteToken()` from `lib/invitation.ts` — because only the caller can
-- ever hold the raw value to email it. The function never sees it and could not
-- reproduce it; it only stores the hash, exactly as every other invitation.
--
-- Returns the new invitation id when this call completes the application
-- (individual: immediately; corporate: the second approval), so the caller knows
-- to send the invite email. Returns null for a corporate application's first
-- approval, which is recorded but does not yet decide anything.
create or replace function record_application_approval(
  p_application_id     uuid,
  p_reason             text,
  p_invite_token_hash  text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  v_required  integer;
  v_approvals integer;
  v_invite_id uuid;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then
    raise exception 'no such application';
  end if;
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
  -- Maker-checker: the recommender may never also be an approver.
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
    -- Corporate, first of two. Recorded; not yet decided, nothing to onboard.
    return null;
  end if;

  if p_invite_token_hash is null then
    raise exception 'this approval completes the application and needs an invitation token';
  end if;

  -- The last approval required completes it, and onboards them the same way
  -- every other invited person is onboarded — through accept_invitation, which
  -- since 0081 applies every attachment (here, the unit) under one authority.
  insert into invitations (org_id, email, role, full_name, unit_id, token_hash, invited_by, expires_at)
  values (a.org_id, a.applicant_email, 'tenant', a.applicant_name, a.unit_id,
          p_invite_token_hash, auth.uid(), now() + interval '14 days')
  returning id into v_invite_id;

  update tenant_applications
     set status = 'approved',
         decided_by = auth.uid(),
         decided_at = now(),
         decision_notes = p_reason
   where id = a.id;

  return v_invite_id;
end;
$$;

revoke all on function record_application_approval(uuid, text, text) from public;
grant execute on function record_application_approval(uuid, text, text) to authenticated, service_role;

comment on function record_application_approval is
  'Tier 2. Independent of the recommendation — the recommender can never be an approver, and for a corporate applicant the second approver can never be the first. The completing approval issues a tenant invitation carrying the assigned unit, applied through accept_invitation exactly as any other invitation. The token hash is generated by the caller, exactly as every other invitation in this system — the function never holds the raw value.';

create or replace function record_application_rejection(
  p_application_id uuid,
  p_reason         text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
begin
  select * into a from tenant_applications
   where id = p_application_id and org_id = current_user_org_id() and purged_at is null
   for update;
  if a.id is null then
    raise exception 'no such application';
  end if;
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
     set status = 'rejected',
         decided_by = auth.uid(),
         decided_at = now(),
         decision_notes = p_reason,
         -- Locked retention: rejected/withdrawn purge at 90 days.
         purge_after = now() + interval '90 days'
   where id = a.id;
end;
$$;

revoke all on function record_application_rejection(uuid, text) from public;
grant execute on function record_application_rejection(uuid, text) to authenticated, service_role;

-- ── The queue reads its progress without a join ────────────────────────────
create or replace view application_overview as
  select
    a.id, a.org_id, a.type, a.status,
    a.applicant_name, a.applicant_email, a.applicant_phone,
    a.property_id, a.unit_id,
    a.form,
    a.consent_given_at, a.consent_statement,
    a.submitted_at, a.decided_by, a.decided_at, a.decision_notes,
    a.created_at, a.updated_at,
    (select count(*) from application_attachments t where t.application_id = a.id)
      as attachment_count,
    -- New columns appended at the end: CREATE OR REPLACE VIEW can only add
    -- columns after the existing ones, never reorder or insert among them.
    a.recommendation, a.recommended_by, a.recommended_at,
    (select count(distinct decided_by) from application_decisions d
      where d.application_id = a.id and d.kind = 'approve')
      as approvals_count,
    (case when a.type = 'corporate' then 2 else 1 end)
      as approvals_needed
  from tenant_applications a
  where a.org_id = current_user_org_id()
    and a.purged_at is null
    and (
      has_permission('applications.review_all')
      or a.property_id in (select current_user_property_ids())
    );

comment on view application_overview is
  'Applications WITHOUT the special-category column, with the review progress a queue needs to render without a join. Definer rights, so its WHERE clause is the security boundary.';
