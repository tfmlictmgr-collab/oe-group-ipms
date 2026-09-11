-- The applicant asked for more information could never answer.
-- (Reported after the 28 Aug 2026 demo — "tenant form experienced a stopgap".)
--
-- ⚠️ THE LINK IN THE EMAIL DOES NOT WORK. Proven against the live database,
-- with the real OEA applicant's own unexpired token:
--
--     application b1d4da73…  status=info_requested  token live=true
--     resume_application(<their own valid token>)  ->  0 rows
--
-- They see "This link no longer works". There is no other way in.
--
-- `record_application_info_request` (0082) reopens an application by setting
-- `status = 'info_requested'` on a freshly minted token. `resume_application`
-- matches `status = 'draft'` and nothing else, so the state the reviewer puts
-- them in is the one state the door refuses.
--
-- 📌 **0082d fixed the two functions DOWNSTREAM of this one and not this one.**
-- Its header says an applicant "asked to upload a clearer document could not
-- upload one", and it widened `record_application_attachment` — correctly —
-- noting `submit_tenant_application` was already widened. Neither is reachable:
-- both take the resume token, and the applicant cannot get past the page that
-- resolves it. A migration written against the reported symptom rather than
-- against the rule, which is 0185's lesson almost word for word.
--
-- Asking the catalogue instead of guessing — every function keyed on
-- `resume_token_hash`, and what status each accepts — finds TWO doors shut, not
-- one:
--
--     record_application_attachment    draft + info_requested   ok (0082d)
--     submit_tenant_application        draft + info_requested   ok
--     resume_application               DRAFT ONLY   <-- cannot open the form
--     save_application_draft           DRAFT ONLY   <-- cannot save an edit
--
-- So even an applicant who somehow reached the form could not have kept an
-- answer in it.
--
-- ── And nobody was told when they did answer ──────────────────────────────
--
-- `submit_tenant_application` had no notification at all — not on a first
-- submission, not on a resubmission. The vendor twin
-- (`submit_vendor_registration`, 0164) has notified its review desk since the
-- day it shipped. So the loop had no return path even once the door opens: the
-- reviewer asks, the applicant answers, and the application quietly returns to
-- `submitted` where somebody has to happen to look at it.
--
-- ⚠️ All three rewritten from the LIVE definitions (`pg_get_functiondef`), per
-- the 0136 lesson. `submit_tenant_application` in particular is granted to
-- `anon` and carries the consent gate and the required-document gate; every
-- byte of those is what was running.

-- ── 1. The door ───────────────────────────────────────────────────────────
--
-- The return shape gains `info_request_reason`, so the form can show the
-- applicant WHAT WAS ASKED. Until now that existed only in the email — open the
-- link on another device, or lose the mail, and you are looking at your own
-- answers with no indication of which one is wrong. The reviewer's words are
-- already stored verbatim on `application_decisions`; this is the read path
-- that was missing.
drop function if exists resume_application(text);

create function resume_application(p_token_hash text)
returns table (
  id uuid, org_id uuid, type application_type, status application_status,
  applicant_name text, applicant_email text, applicant_phone text,
  property_id uuid, unit_id uuid, form jsonb,
  info_request_reason text
)
language sql stable security definer set search_path = public as $fn$
  select a.id, a.org_id, a.type, a.status,
         a.applicant_name, a.applicant_email, a.applicant_phone,
         a.property_id, a.unit_id, a.form,
         case when a.status = 'info_requested' then (
           select d.reason from application_decisions d
            where d.application_id = a.id and d.kind = 'request_info'
            order by d.created_at desc limit 1
         ) end
    from tenant_applications a
   where a.resume_token_hash = p_token_hash
     and a.status in ('draft', 'info_requested')
     and a.resume_expires_at > now()
     and a.purged_at is null;
$fn$;

revoke all on function resume_application(text) from public;
grant execute on function resume_application(text) to anon, authenticated, service_role;

comment on function resume_application is
  'Reopens a saved OR reopened application from its resume token. Accepts `info_requested` as well as `draft` (0219) — it matched draft alone, so the link a reviewer sends when asking for more information resolved to nothing and the applicant was told "this link no longer works". Returns the reviewer''s own words with it, because until now what was being asked for existed only in the email.';

-- ── 2. Their edits have somewhere to go ───────────────────────────────────
create or replace function save_application_draft(p_token_hash text, p_form jsonb, p_sensitive jsonb)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
begin
  select id into v_id from tenant_applications
   where resume_token_hash = p_token_hash
     -- Widened with resume_application (0219). An applicant answering a
     -- reviewer's question is editing, and an edit that cannot be saved is the
     -- same dead end one step further in.
     and status in ('draft', 'info_requested')
     and resume_expires_at > now()
     and purged_at is null;

  if v_id is null then
    return false;   -- expired, submitted, or never existed: all the same answer
  end if;

  update tenant_applications
     set form = coalesce(p_form, '{}'::jsonb),
         sensitive = coalesce(p_sensitive, '{}'::jsonb)
   where id = v_id;

  return true;
end;
$fn$;

comment on function save_application_draft is
  'Saves an in-progress application from its resume token, in `draft` or `info_requested` (0219). Answers false rather than raising for an expired, submitted or unknown token — the three are deliberately indistinguishable to a caller.';

-- ── 3. The reviewer is told the answer arrived ────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_tenant_application(p_token_hash text, p_form jsonb, p_sensitive jsonb, p_consent text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_was_info_requested boolean;
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

  -- Captured before the UPDATE below overwrites it.
  v_was_info_requested := a.status = 'info_requested';
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

  -- ⚠️ NOBODY WAS TOLD. This function had no notification of any kind, so an
  -- application — a first submission, or an applicant answering a reviewer's
  -- question — landed in the table and waited to be noticed. The vendor twin,
  -- `submit_vendor_registration`, has notified its review desk since 0164; the
  -- tenant half never did. That is the half of the "request more info" loop
  -- with no return path: the reviewer asks, the applicant answers, and the
  -- reviewer is never told the answer arrived.
  --
  -- The two cases are deliberately worded differently. "A new application" and
  -- "they have answered your question" send a reviewer to different places in
  -- their queue, and a single generic line would make the loop invisible again.
  perform notify_role(
    a.org_id,
    array_cat(array['admin']::user_role[], fm_roles()),
    'application',
    case when v_was_info_requested
         then 'An applicant answered your request'
         else 'A new tenancy application' end,
    a.applicant_name ||
      case when v_was_info_requested
           then ' has updated their application and sent it back for review.'
           else ' submitted a tenancy application.' end,
    '/dashboard/people/tenancy/' || a.id::text,
    'tenant_application',
    a.id
  );

  return a.id;
end;
$function$;
