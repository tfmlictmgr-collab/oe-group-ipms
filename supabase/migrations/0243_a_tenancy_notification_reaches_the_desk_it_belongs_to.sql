-- The submission notification blast, narrowed to the desk the property is on.
--
-- Found investigating 0242's 404: one OEA submission notified NINE people —
-- every admin, facility_manager, property_manager AND regional_manager in
-- the org — via `array_cat(['admin'], fm_roles())` in `submit_tenant_application`
-- (0219). `tenant_applications_staff_select` (0062) has never let most of
-- them read it: an FM/PM/RM sees only `property_id in
-- current_user_property_ids()`, their own places, unless they hold
-- `applications.review_all` (nobody does — 0241 §5 proves it). So eight of
-- those nine got a notification for a building they have no reach into at
-- all, every time, on every submission and every info-request answer.
--
-- 0242 already stops the click from 404ing — `target_live` now runs the
-- existence check under the READER's own RLS, so an out-of-scope recipient
-- sees the link correctly greyed out instead of an error page. This
-- migration fixes the cause 0242 was covering for: send the notification
-- only to the desk that can actually act on it, the same join
-- `system_recommend_application` (0241) already uses for its own hand-off,
-- so a submission and the completeness check that follows it tell the same
-- people.
--
-- Admin is unaffected — already unconditional, stays unconditional, because
-- `applications.approve` sat with `admin` before 0241 moved it and an
-- administrator remains the 24-hour fallback (0241 §3) regardless of who
-- else is told.

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
  v_title text;
  v_body text;
  v_user uuid;
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

  -- The two cases are deliberately worded differently. "A new application" and
  -- "they have answered your question" send a reviewer to different places in
  -- their queue, and a single generic line would make the loop invisible again.
  v_title := case when v_was_info_requested
                  then 'An applicant answered your request'
                  else 'A new tenancy application' end;
  v_body := a.applicant_name ||
    case when v_was_info_requested
         then ' has updated their application and sent it back for review.'
         else ' submitted a tenancy application.' end;

  -- Admin: unconditional, org-wide, exactly as before (0242's header
  -- explains why this line is untouched).
  perform notify_role(a.org_id, array['admin']::user_role[], 'application',
    v_title, v_body, '/dashboard/people/tenancy/' || a.id::text,
    'tenant_application', a.id);

  -- Operational staff: only those whose place actually covers this property
  -- — the same expansion 0241's `system_recommend_application` uses to hand
  -- the completeness check to the region, read here at submission time
  -- instead of at hand-off.
  if a.property_id is not null then
    for v_user in
      select distinct s.user_id
        from property_stakeholders s
        join users u on u.id = s.user_id
       where s.org_id = a.org_id
         and u.deactivated_at is null
         and u.role in ('facility_manager', 'property_manager', 'regional_manager')
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
      perform notify_user(v_user, 'application', v_title, v_body,
        '/dashboard/people/tenancy/' || a.id::text, 'tenant_application', a.id);
    end loop;
  end if;

  return a.id;
end;
$function$;

comment on function submit_tenant_application is
  'Accepts a tenant application from `draft`/`info_requested` (0219). Notifies admin org-wide, unconditionally, plus the facility/property/regional manager whose place actually covers the property (0243) -- previously every fm_roles() holder in the org regardless of scope, which meant 8 of every 9 recipients on a typical OEA org held no RLS access to the row they were told about at all.';
