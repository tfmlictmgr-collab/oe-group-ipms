-- Applicant and vendor documents are read by the people who review them, and
-- an application's decision is written only by the functions that record one
-- (found 9 Oct 2026; decided with the requester 10 Oct 2026).
--
-- ── What was measured (staging, pg_policy on storage.objects) ──────────────
--   "staff read their org documents"            (SELECT, authenticated)
--       bucket_id = 'application-documents'
--       AND (storage.foldername(name))[1]::uuid = current_user_org_id()
--   "vendor documents readable within the org"  (SELECT, authenticated)
--       bucket_id = 'vendor-documents'
--       AND (storage.foldername(name))[1]::uuid = current_user_org_id()
-- Neither names a role. Every signed-in member of the organisation (a tenant,
-- a vendor login of ANY company, a landlord, an Owner Rep, an observer, ops
-- staff) could list both buckets through the storage API and download an
-- applicant's identity documents and bank statements (decision 10, NDPA) and
-- every contractor's CAC, TIN and bank evidence (decision 17). The tables that
-- describe those files were scoped correctly the whole time; the bytes were
-- not. The policy name said "staff" and the expression said "anyone".
--
-- ── The rule: a file is readable by whoever may read its record ───────────
-- Not restated, delegated. Each storage policy now also requires that the
-- caller can see the row that records the object:
--   • application-documents → an `application_attachments` row with that
--     storage path. That table's own policy reads through `tenant_applications`
--     (below), so the document follows the application, not the org.
--   • vendor-documents → a `vendor_documents` row with that storage path. That
--     table's policy is the vendor's own users (`current_user_vendor_ids()`,
--     decision 17's resolver) or a holder of `vendors.read`.
-- Decision 8's rule: a second statement of who may read an application would
-- be a policy with two versions, which is what 0184 had to go back and fix on
-- tickets. An object with no record (a suite's orphan, an upload whose record
-- was never written) is now readable by nobody signed in; the service role,
-- which the screening job and the vendor-copy job use, is unaffected.
--
-- ── The place branch states who it is for (decision 19) ───────────────────
-- `tenant_applications_staff_select`, `application_document_findings_select`
-- and `application_overview` admitted `property_id in current_user_property_ids()`
-- with no role guard. The resolver does not filter on relation, so a LANDLORD
-- attached to a building read every application on it, the applicant's
-- identity findings included. B7 gives a landlord nothing of the kind, and the
-- requester confirmed they must not. 0327 had already excluded the Owner Rep;
-- the branch now names who it is for instead of who it is not:
-- `caller_reviews_applications()` — a holder of applications.recommend,
-- applications.approve or applications.review_all. Measured on staging, the
-- only stakeholder role this removes is `property_owner`; every FM, PM,
-- regional manager and administrator stakeholder holds a reviewing capability.
-- 0327's Owner Rep refusal is kept verbatim (rebuilt from the live catalogue,
-- never from 0327's text). `application_attachments_staff_select`,
-- `application_decisions_select` and `tenancy_offers_select` read through
-- `tenant_applications` and follow it without a change.
--
-- ── The direct UPDATE is withdrawn ────────────────────────────────────────
-- `authenticated` held UPDATE on every column of `tenant_applications` —
-- status, decided_by, decided_at, decision_notes, recommendation — and
-- `tenant_applications_staff_update` admitted the same unguarded place branch,
-- without even the Owner Rep refusal. No trigger checks a status change. So a
-- landlord, or any reviewer, could PATCH status = 'approved' and skip the
-- two-tier review entirely: decision 10's rubber stamp, reached by a REST call,
-- and the forged decision of 0216 one table over. Every product write already
-- goes through a SECURITY DEFINER function (record_application_*,
-- assign_application_unit, save_application_draft, submit_tenant_application,
-- the purge and escalation jobs); no application code updates the table under
-- a user's session. So the policy is dropped and UPDATE revoked from
-- `authenticated` and `anon` (0216's shape: the functions are the only door).
--
-- Rebuilt from the live catalogue through swaps that refuse unless they match
-- exactly once (0183), CR-free on both sides (0317).

set local lock_timeout = '5s';

-- ── 0. Swap helper (this transaction only) ─────────────────────────────────
create or replace function pg_temp.swap_once(p_what text, p_text text, p_old text, p_new text)
returns text language plpgsql as $$
declare
  d text := replace(p_text, E'\r', '');
  o text := replace(p_old, E'\r', '');
begin
  if d is null then
    raise exception '0331: % not found', p_what;
  end if;
  if (length(d) - length(replace(d, o, ''))) / length(o) <> 1 then
    raise exception '0331: % — expected the text to swap exactly once', p_what;
  end if;
  return replace(d, o, replace(p_new, E'\r', ''));
end $$;

-- ── 1. Who reviews applications, named once ───────────────────────────────
create or replace function caller_reviews_applications()
returns boolean
language sql stable
set search_path = public
as $$
  select has_permission('applications.recommend')
      or has_permission('applications.approve')
      or has_permission('applications.review_all');
$$;

revoke all on function caller_reviews_applications() from public, anon;
grant execute on function caller_reviews_applications() to authenticated, service_role;

comment on function caller_reviews_applications() is
  'True when the caller holds a capability to review tenancy applications. The place branch of every application reader requires it, so a landlord or Owner Rep attached to a property reads no applications on it (0331).';

-- ── 2. The application readers ────────────────────────────────────────────
do $$
declare
  q text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into q
    from pg_policy p
   where p.polrelid = 'public.tenant_applications'::regclass
     and p.polname = 'tenant_applications_staff_select';
  q := pg_temp.swap_once('tenant_applications_staff_select', q,
    '(property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids))',
    '(( SELECT caller_reviews_applications()) AND (property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids)))');
  execute format('alter policy tenant_applications_staff_select on public.tenant_applications using (%s)', q);

  select pg_get_expr(p.polqual, p.polrelid) into q
    from pg_policy p
   where p.polrelid = 'public.application_document_findings'::regclass
     and p.polname = 'application_document_findings_select';
  q := pg_temp.swap_once('application_document_findings_select', q,
    '(a.property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids))',
    '(( SELECT caller_reviews_applications()) AND (a.property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids)))');
  execute format('alter policy application_document_findings_select on public.application_document_findings using (%s)', q);

  -- Not security_invoker: it runs as its owner and its own WHERE is the gate.
  q := pg_temp.swap_once('application_overview',
    pg_get_viewdef('public.application_overview'::regclass),
    '(property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids))',
    '(caller_reviews_applications() AND (property_id IN ( SELECT current_user_property_ids() AS current_user_property_ids)))');
  execute 'create or replace view public.application_overview as ' || q;
end $$;

-- ── 3. The direct UPDATE ──────────────────────────────────────────────────
drop policy if exists tenant_applications_staff_update on public.tenant_applications;
-- Revoking the table privilege revokes the column privileges with it.
revoke update on public.tenant_applications from authenticated, anon;

-- ── 4. The two buckets ────────────────────────────────────────────────────
-- A storage listing evaluates the policy per object; the vendor lookup had no
-- index on the path (the attachments one is unique already).
create index if not exists vendor_documents_storage_path_idx
  on public.vendor_documents (storage_path);

do $$
declare
  q text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into q
    from pg_policy p
   where p.polrelid = 'storage.objects'::regclass
     and p.polname = 'staff read their org documents';
  if q is null or q not like '%application-documents%' or strpos(q, 'storage_path') > 0 then
    raise exception '0331: "staff read their org documents" missing or already changed';
  end if;
  execute format($f$alter policy "staff read their org documents" on storage.objects using ((%s) AND (EXISTS (
      SELECT 1 FROM public.application_attachments t WHERE t.storage_path = objects.name)))$f$, q);

  select pg_get_expr(p.polqual, p.polrelid) into q
    from pg_policy p
   where p.polrelid = 'storage.objects'::regclass
     and p.polname = 'vendor documents readable within the org';
  if q is null or q not like '%vendor-documents%' or strpos(q, 'storage_path') > 0 then
    raise exception '0331: "vendor documents readable within the org" missing or already changed';
  end if;
  execute format($f$alter policy "vendor documents readable within the org" on storage.objects using ((%s) AND (EXISTS (
      SELECT 1 FROM public.vendor_documents d WHERE d.storage_path = objects.name)))$f$, q);
end $$;

-- ── 5. Assertions ─────────────────────────────────────────────────────────
do $$
begin
  -- Every application reader names its reviewers AND keeps 0327's refusal.
  if exists (
    select 1 from (values ('tenant_applications', 'tenant_applications_staff_select'),
                          ('application_document_findings', 'application_document_findings_select')) v(t, p)
     where not exists (select 1 from pg_policy x
                        where x.polrelid = ('public.' || v.t)::regclass and x.polname = v.p
                          and pg_get_expr(x.polqual, x.polrelid) like '%caller_reviews_applications()%'
                          and pg_get_expr(x.polqual, x.polrelid) like '%NOT caller_is_owner_rep()%')
  ) then
    raise exception '0331: an application policy lost its reviewer guard or its Owner Rep refusal';
  end if;
  if pg_get_viewdef('public.application_overview'::regclass) not like '%caller_reviews_applications()%'
     or pg_get_viewdef('public.application_overview'::regclass) not like '%NOT caller_is_owner_rep()%' then
    raise exception '0331: application_overview lost its reviewer guard or its Owner Rep refusal';
  end if;
  -- No reader of an application still admits the bare place branch.
  if exists (select 1 from pg_policy x
              where x.polrelid in ('public.tenant_applications'::regclass,
                                   'public.application_document_findings'::regclass)
                and pg_get_expr(x.polqual, x.polrelid) like '%current_user_property_ids%'
                and pg_get_expr(x.polqual, x.polrelid) not like '%caller_reviews_applications()%') then
    raise exception '0331: an application policy still admits the place branch without a reviewer guard';
  end if;

  -- The direct write is gone, policy and privilege both.
  if exists (select 1 from pg_policy where polrelid = 'public.tenant_applications'::regclass and polcmd = 'w') then
    raise exception '0331: an UPDATE policy remains on tenant_applications';
  end if;
  if has_any_column_privilege('authenticated', 'public.tenant_applications', 'UPDATE')
     or has_any_column_privilege('anon', 'public.tenant_applications', 'UPDATE') then
    raise exception '0331: a client role still holds UPDATE on tenant_applications';
  end if;

  -- Both buckets require the record.
  if not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass
                    and polname = 'staff read their org documents'
                    and strpos(pg_get_expr(polqual, polrelid), 'application_attachments t') > 0) then
    raise exception '0331: application-documents is not gated on its record';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass
                    and polname = 'vendor documents readable within the org'
                    and strpos(pg_get_expr(polqual, polrelid), 'vendor_documents d') > 0) then
    raise exception '0331: vendor-documents is not gated on its record';
  end if;
  -- And no other SELECT policy reads either bucket around them.
  if exists (select 1 from pg_policy where polrelid = 'storage.objects'::regclass and polcmd in ('r', '*')
                and pg_get_expr(polqual, polrelid) ~ 'application-documents|vendor-documents'
                and polname not in ('staff read their org documents', 'vendor documents readable within the org')) then
    raise exception '0331: another policy reads application-documents or vendor-documents';
  end if;

  -- The helper is not callable anonymously (0204/0209/0264).
  if exists (select 1 from information_schema.routine_privileges
              where routine_schema = 'public' and routine_name = 'caller_reviews_applications'
                and grantee in ('PUBLIC', 'anon')) then
    raise exception '0331: caller_reviews_applications is callable anonymously';
  end if;
end $$;
