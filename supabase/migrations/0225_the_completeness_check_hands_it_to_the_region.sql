-- A tenancy application that nobody could approve, and nobody was told about.
--
-- 🚨 The dead end, reproduced on OEA: an administrator opens an application,
-- presses "Recommend approval", and it stops there for ever. Three separate
-- faults compound into it:
--
--   1. `record_application_recommendation` (0082) NOTIFIES NOBODY. Submission
--      notifies (0219, admin + fm_roles); recommending — the step that creates
--      an obligation on somebody else — sends nothing at all. The approver is
--      never told an approval is owed.
--   2. Maker-checker then locks out the one person who was looking at it: the
--      recommender may never approve. Correct, and it leaves the application
--      needing a second human nobody has named.
--   3. Who that second human is, is wrong. Live, `applications.approve` is
--      held by `admin`, `executive` and `finance_approver` — the Managing
--      Director and the Payment Officer. A tenancy is not a money decision,
--      and the person who actually runs the estate the flat is in — the
--      REGIONAL MANAGER — could only ever recommend.
--
-- Board direction, 30 Aug 2026: completeness is checked automatically and the
-- application is passed to a human reviewer — the regional manager for the
-- property's own location — who reviews and decides. The administrator is the
-- fill-in when it has sat unattended for 24 hours, and is told so.
--
-- ── What the automatic step is, and is not ────────────────────────────────
-- It checks that every REQUIRED DOCUMENT is attached and every COMPULSORY
-- FIELD is filled. That is arithmetic on a form, not an opinion about a
-- person: it reads no answer's content, weighs nothing, scores nothing and
-- ranks nobody. The locked decision that "screening is human, never
-- automated" is about judging an applicant, and this judges an envelope.
--
-- So the decision it records says exactly that, and the row carries
-- `decided_by = NULL` — because no person decided it. Two consequences that
-- matter and are deliberate:
--
--   * `tenant_applications.recommended_by` also stays NULL, so the
--     maker-checker test in `record_application_approval`
--     (`a.recommended_by = auth.uid()`) is NULL and therefore never true.
--     An automatic recommendation must not consume a human's independence —
--     every human reviewer is still free to decide either way.
--   * the review history shows it as machine-made rather than as somebody's
--     recommendation, which is the whole of what makes it auditable.
--
-- Nothing here approves, rejects or onboards anyone. A human still assigns the
-- unit and still records their own reason (decision 10), and
-- `record_application_approval` is untouched.

-- ── 1. A decision can be the system's ─────────────────────────────────────
alter table application_decisions alter column decided_by drop not null;

-- NULL means the automated completeness check, and nothing else. A human
-- always writes `auth.uid()`, so this admits exactly the one case above and
-- keeps every other kind attributable to a person.
alter table application_decisions
  drop constraint if exists application_decisions_actor_or_system;
alter table application_decisions
  add constraint application_decisions_actor_or_system
  check (decided_by is not null or kind = 'recommend_approve');

comment on column application_decisions.decided_by is
  'The person who decided. NULL only on a recommend_approve written by the automated completeness check (0225) - no person decided it, and the review history says so rather than attributing a machine step to somebody.';

-- Stamped so the check speaks once per application, and the 24-hour nudge
-- fires once. The ROW is the record of having been told; the schedule never
-- was (decision 15, and 0212's escalation says the same).
alter table tenant_applications
  add column if not exists screened_at   timestamptz,
  add column if not exists escalated_at  timestamptz;

comment on column tenant_applications.screened_at is
  'When the automated completeness check passed this application to a human reviewer (0225). Set once; its presence is what stops the job speaking twice.';
comment on column tenant_applications.escalated_at is
  'When the administrators were told this application had sat unattended for 24 hours (0225). Set once, for the same reason.';

-- ── 2. The completeness check hands it to the region ──────────────────────
--
-- ⚠️ Service role only, and it takes the basis as an argument rather than
-- computing it. The compulsory fields are declared in `lib/application-form.ts`
-- and the required documents in `application_document_requirements`; the job
-- route reads both. Restating the field list in SQL would be a second copy of
-- a list that must agree with the first, and this codebase has been bitten by
-- exactly that often enough to have written it down.
create or replace function system_recommend_application(
  p_application_id uuid,
  p_basis          text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a tenant_applications%rowtype;
  v_user uuid;
  v_told int := 0;
begin
  select * into a from tenant_applications
   where id = p_application_id and purged_at is null
   for update;
  if a.id is null then return false; end if;

  -- Only ever from the front of the queue, and only once.
  if a.status <> 'submitted' or a.screened_at is not null then return false; end if;
  if length(trim(coalesce(p_basis, ''))) < 10 then
    raise exception 'the basis for an automatic recommendation must be recorded';
  end if;

  insert into application_decisions (org_id, application_id, kind, decided_by, reason)
  values (a.org_id, a.id, 'recommend_approve'::application_decision_kind, null, trim(p_basis));

  update tenant_applications
     set status         = 'under_review',
         recommendation = 'approve',
         recommended_by = null,
         recommended_at = now(),
         screened_at    = now()
   where id = a.id;

  -- ── Who is told: the region the property is actually in ────────────────
  -- A regional manager attached to an ancestor node reaches every property
  -- beneath it — the same expansion `current_user_property_ids()` performs,
  -- read in the other direction. A manager attached to the property itself
  -- counts too.
  for v_user in
    select distinct s.user_id
      from property_stakeholders s
      join users u on u.id = s.user_id
     where s.org_id = a.org_id
       and u.deactivated_at is null
       and u.role = 'regional_manager'
       and a.property_id is not null
       and (
         s.property_id = a.property_id
         or exists (
           select 1
             from properties p
             join org_nodes n   on n.id = p.site_node_id and n.org_id = p.org_id
             join org_nodes anc on n.path like anc.path || '%' and anc.org_id = n.org_id
            where p.id = a.property_id
              and anc.id = s.node_id
              and anc.deleted_at is null
              and n.deleted_at is null
              and p.deleted_at is null
         )
       )
  loop
    perform notify_user(
      v_user, 'application',
      'A tenancy application is ready for your decision',
      a.applicant_name || ' — every required document is attached and every '
        || 'compulsory field is filled. Read it and decide.',
      '/dashboard/people/tenancy/' || a.id::text
    );
    v_told := v_told + 1;
  end loop;

  -- No regional manager on that place — or no property on the application at
  -- all — means there is nobody whose region it is. Say so to the people who
  -- can act rather than letting it sit silently, which is the fault this
  -- migration exists to end.
  if v_told = 0 then
    perform notify_role(
      a.org_id, array['admin']::user_role[], 'application',
      'A tenancy application has no regional manager to decide it',
      a.applicant_name || ' is complete and ready to decide, but no regional '
        || 'manager is attached to its property or region. Decide it, or attach one.',
      '/dashboard/people/tenancy/' || a.id::text
    );
  end if;

  return true;
end;
$$;

revoke all on function system_recommend_application(uuid, text) from public, anon, authenticated;
grant execute on function system_recommend_application(uuid, text) to service_role;

comment on function system_recommend_application is
  'Records the automated completeness check as a recommendation with no human actor, and tells the regional manager for the property''s own location that a decision is owed. Decides nothing: a human still assigns the unit, states their own reason and approves or rejects.';

-- ── 3. The administrator is the fill-in at 24 hours ───────────────────────
--
-- ⚠️ This GRANTS NOTHING, exactly as `escalate_stale_unassigned_requests`
-- grants nothing. An administrator already holds `applications.approve`; what
-- they lacked was any way to learn an application needed them. If this job
-- never runs, the administrator can still decide and all that is lost is the
-- nudge — the record decides, never the schedule (decision 15).
create or replace function escalate_stale_applications()
returns int language plpgsql security definer set search_path = public as $$
declare
  a record;
  v_count int := 0;
begin
  for a in
    select t.id, t.org_id, t.applicant_name
      from tenant_applications t
     where t.purged_at is null
       and t.status in ('submitted', 'under_review')
       and t.escalated_at is null
       and coalesce(t.submitted_at, t.created_at) <= now() - interval '24 hours'
       -- Nobody has actually acted. An automatic recommendation is not
       -- attention: it is the thing that asked for attention.
       and not exists (
         select 1 from application_decisions d
          where d.application_id = t.id and d.decided_by is not null
       )
  loop
    perform notify_role(
      a.org_id, array['admin']::user_role[], 'application',
      'A tenancy application has waited 24 hours',
      a.applicant_name || ' has had no decision since it was submitted. '
        || 'Approve it, reject it, or ask the applicant for more.',
      '/dashboard/people/tenancy/' || a.id::text
    );
    update tenant_applications set escalated_at = now() where id = a.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function escalate_stale_applications() from public, anon, authenticated;
grant execute on function escalate_stale_applications() to service_role;

-- ── 4. The region decides, because the region is where the property is ────
--
-- `applications.approve` moves onto `regional_manager`. It is already scoped
-- correctly without another line being written: `record_application_approval`
-- admits a caller only when the application's property is in
-- `current_user_property_ids()`, which for a regional manager is their own
-- node subtree and nothing else. "Approve based on the location of the
-- property" is therefore the scoping that already exists, finally reachable.
--
-- 🚨 And `applications.review_all` comes OFF that arm, where 0184 put it back.
-- Audit 0729b-S1 removed it in 0077 as a High finding — it is defined as
-- "read every tenant application in the organisation, not only those for
-- properties they are attached to", which is the org-wide read decision 9
-- denies the role, and it carries every applicant's identity documents. The
-- live rows never had it (checked, all four orgs); only the seed did, so this
-- has been latent for new organisations rather than leaking today. It also
-- matters more now than it did an hour ago: `review_all` is the clause that
-- BYPASSES the property scoping above, so leaving it would have handed a
-- regional manager approval over every application in the organisation — the
-- exact opposite of what this migration is for.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when cap.key = 'tickets.assign_without_review' then false
        when cap.key = 'training.read' then false
        when cap.key = 'records.export' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          -- 0225: the region decides its own tenancies. Bounded to their node
          -- subtree by record_application_approval's own property check, which
          -- is why `applications.review_all` must NOT be here.
          'applications.recommend', 'applications.approve'
        )

        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r in ('facility_manager', 'property_manager')

        when cap.key = 'vendors.read'
          then r in ('facility_manager', 'property_manager', 'finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read'
          then r in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

comment on function seed_b7_permissions is
  'What a NEW org starts with, and what "reset to B7" returns an existing one to (0184, +0203 training.read, +0223 records.export, +0225 the regional manager approves tenancies for their own region and loses the org-wide application read 0077 had already removed). A capability not named here falls to `else false` -- decision 7''s "B7 silent means OFF".';

-- Existing organisations get the grant that unblocks them. Deliberately only
-- the ADD: revoking review_all from live rows would be a change to what
-- somebody holds today, and no live row holds it (checked) — so there is
-- nothing to revoke and no silent removal to explain.
insert into role_permissions (org_id, role, capability, granted)
select o.id, 'regional_manager'::user_role, 'applications.approve', true
  from orgs o
 where o.deleted_at is null and not o.is_platform_operator
on conflict (org_id, role, capability) do update set granted = true;

-- ── 5. Prove it ───────────────────────────────────────────────────────────
do $$
declare
  v_missing text;
  v_leaked  text;
begin
  select string_agg(o.slug, ', ') into v_missing
    from orgs o
   where o.deleted_at is null and not o.is_platform_operator
     and not exists (
       select 1 from role_permissions rp
        where rp.org_id = o.id and rp.role = 'regional_manager'
          and rp.capability = 'applications.approve' and rp.granted
     );
  if v_missing is not null then
    raise exception 'regional_manager still cannot approve on: %', v_missing;
  end if;

  -- The scoping this whole migration depends on.
  select string_agg(o.slug, ', ') into v_leaked
    from orgs o
    join role_permissions rp on rp.org_id = o.id
   where o.deleted_at is null
     and rp.role = 'regional_manager'
     and rp.capability = 'applications.review_all' and rp.granted;
  if v_leaked is not null then
    raise exception
      'regional_manager holds applications.review_all on %, which bypasses the property scoping', v_leaked;
  end if;
end;
$$;
