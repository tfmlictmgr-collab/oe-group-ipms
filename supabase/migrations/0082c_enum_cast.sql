-- `case when p_approve then 'recommend_approve' else 'recommend_reject' end`
-- resolves to `text`, and Postgres will not implicitly cast a CASE expression of
-- string literals to `application_decision_kind` inside an INSERT — only a bare
-- literal gets that implicit cast. Caught by the suite on its first run: every
-- recommend call failed with "column kind is of type application_decision_kind
-- but expression is of type text", so nothing downstream of a recommendation
-- could be exercised either.

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
          (case when p_approve then 'recommend_approve' else 'recommend_reject' end)::application_decision_kind,
          auth.uid(), p_reason);

  update tenant_applications
     set status = 'under_review',
         recommendation = case when p_approve then 'approve' else 'reject' end,
         recommended_by = auth.uid(),
         recommended_at = now()
   where id = a.id;
end;
$$;
