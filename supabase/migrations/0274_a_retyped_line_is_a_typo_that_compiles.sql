-- A retyped line is a typo that compiles (8 Sept 2026).
--
-- 0271 rebuilt `submit_vendor_evaluation` and its own header claimed the move
-- was mechanical: "every standing, duplicate, rubric and scoring rule below is
-- catalogue output, moved and not retyped." One line was not.
--
-- The established wording, stable across `0220` and `0234`:
--
--   'the satisfaction rating belongs to the tenant who reported this — rate
--    the quality of the work instead'
--
-- 0271 shipped instead:
--
--   'the satisfaction rating is the tenant''s — you hold management authority
--    on this request'
--
-- Same rule, different sentence, and the difference is not cosmetic: the
-- original told an FM what to do next ("rate the quality of the work
-- instead"); the rewrite only told them what they could not do. Neither is
-- wrong on its own, but 0271 did not decide to change it — it happened while
-- rebuilding a function for an unrelated reason (the tenant's own optional
-- comment) and passed unnoticed because nothing in that migration's own
-- verification touched this specific refusal.
--
-- ⚠️ Found by running `verify-fm-journey`, not by reading — it has asserted
-- this exact phrase (`/satisfaction rating belongs to the tenant/i`) since
-- 0220, and it was the first time that suite ran since 0271 landed. The
-- behaviour was never wrong: an FM rating their own work as the tenant has
-- been refused throughout. What drifted was the sentence a person actually
-- reads, and 0183's own lesson is that this is exactly the class of loss a
-- "moved, not retyped" claim exists to prevent — restated here because
-- restating it apparently was not enough the first four times.
--
-- One line reverted. Everything else in 0271's body — the comment parameter,
-- the length guard, the insert — is correct and untouched.

create or replace function submit_vendor_evaluation(
  p_ticket_id uuid,
  p_source text,
  p_responses jsonb,
  p_comment text default null
)
returns uuid language plpgsql security definer set search_path = public as $function$
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
  v_seen_criteria uuid[] := '{}';
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  -- 0195. Null-safe by construction: current_user_is_active() returns a
  -- boolean from exists(), never NULL, and the auth.uid() test keeps the
  -- service role (scheduled jobs, webhooks) passing straight through.
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
      -- 0220. The tenant half is the TENANT's. An FM who raised a work order is
      -- its reporter and holds management authority, which is not the same
      -- thing, and letting them file the satisfaction score would let one desk
      -- score both halves of a composite that gates a payment.
      if current_user_role() is distinct from 'tenant' then
        raise exception 'the satisfaction rating belongs to the tenant who reported this — rate the quality of the work instead';
      end if;
    else
      if not (
        current_user_role() = any (oversight_roles())
        or (current_user_role() = any (fm_roles())
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
      else null
    end;

    if v_points is null then
      raise exception 'unrecognised answer "%" for: %', v_line->>'value', crit.label;
    end if;

    insert into evaluation_responses (org_id, evaluation_id, criterion_id, value, points)
    values (v_org, v_eval, crit.id, v_line->>'value', v_points);

    v_seen_criteria := v_seen_criteria || crit.id;
  end loop;

  perform recompute_evaluation_scores(v_eval);
  return v_eval;
end;
$function$;

comment on function submit_vendor_evaluation is
  'One source''s half of a job''s evaluation: the tenant''s satisfaction, or the FM/PM''s quality and compliance. Optionally carries the evaluator''s own words (0271), which explain a score and never change one — the composite stays the rubric. The tenant-source guard reads exactly as it has since 0220 (0274 restored the wording after 0271 retyped it while rebuilding for an unrelated reason).';

revoke all on function submit_vendor_evaluation(uuid, text, jsonb, text) from public, anon;
grant execute on function submit_vendor_evaluation(uuid, text, jsonb, text) to authenticated, service_role;

-- ── Prove the wording, not just the refusal ────────────────────────────────
--
-- A behaviourally-identical refusal in different words is still a defect —
-- it is the sentence a real person reads, and `verify-fm-journey` has matched
-- this exact phrase since 0220. Asserting it here means the next rebuild that
-- silently retypes it fails the migration, not a suite run days later.
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_vendor_evaluation';

  if v_def !~ 'satisfaction rating belongs to the tenant who reported this' then
    raise exception 'submit_vendor_evaluation no longer carries the established tenant-guard wording';
  end if;
end $$;
