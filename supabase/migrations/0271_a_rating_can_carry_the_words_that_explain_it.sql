-- A rating can carry the words that explain it (7 Sept 2026).
--
-- Asked for: "tenant should be able to add an optional comment during the
-- vendor evaluation process."
--
-- `vendor_evaluations` has held five numbers since `0001` and never a sentence.
-- So the record of a job says the tenant scored satisfaction 60 and cannot say
-- WHY — whether the work was poor, or fine but three weeks late, or fine and
-- the contractor left the stairwell filthy. The number feeds the composite that
-- gates the vendor's payment (B4); the reason it moved was thrown away.
--
-- ⚠️ The comment does NOT score, and that is deliberate. The composite is a
-- weighted sum of the rubric's own criteria (30/20/20/20/10) and stays exactly
-- that. Decision 10's shape one module over: a finding recorded against the
-- evidence it came from, never a conclusion. A free-typed sentence that moved a
-- vendor's payment eligibility would be a rating nobody could audit.
--
-- ── Who reads it, MEASURED rather than asserted ──────────────────────────
--
-- ⚠️ The first draft of this migration said "staff on the job, NOT the
-- contractor", and reasoned about why that was the right default. It was wrong,
-- and it was wrong in the direction that matters. Asked as the seeded vendor:
--
--     vendor reads vendor_evaluations: 5 row(s)
--     sample: { id: …, comment: …, satisfaction_score: 90 }
--
-- `vendor_evaluations_select` (0078a) admits a vendor to their OWN evaluation
-- rows, and RLS is row-level: there is no column for a policy to withhold. So
-- the contractor can read this the moment it is written. Decision 25's lesson,
-- one table over — *a claim that something is unreachable is a measurement, not
-- a reading* — and the probe took a minute where the reasoning took a paragraph.
--
-- So the audience is stated as what it IS: **the evaluator, the staff handling
-- the job, and the contractor being evaluated.** The form says exactly that, in
-- those words, before the box. A comment field that tells a resident their
-- words are private when they are not is worse than no comment field: it
-- invites them to name a person to someone who has their address.
--
-- 📌 Making it staff-only is a real option and deliberately NOT taken here on
-- my own judgement, because it is not free and the cost lands on the contractor:
-- it means dropping the vendor branch from `vendor_evaluations_select` and
-- serving their scorecard from `vendor_evaluation_tickets` instead (that view
-- already omits `comment`), which changes what a vendor can see about their own
-- payment gate. That is a board decision about a control, not a copy tweak.

alter table vendor_evaluations add column if not exists comment text;

comment on column vendor_evaluations.comment is
  'The evaluator''s own words, optional, capped at 2000 characters. Records WHY a score moved — the five numbers have never been able to say it. Deliberately not part of composite_score: the composite is the rubric, and a free-typed sentence that changed payment eligibility would be a rating nobody could audit (0271). Read by the evaluator, the staff handling the job, and — measured, not assumed — the contractor themselves, who holds a row read on their own evaluations (0078a). The form says so before the box.';

alter table vendor_evaluations drop constraint if exists vendor_evaluations_comment_len;
alter table vendor_evaluations add constraint vendor_evaluations_comment_len
  check (comment is null or length(comment) <= 2000);

-- ── The one write path takes it ──────────────────────────────────────────
--
-- Rebuilt from `pg_get_functiondef` (0183) — every standing, duplicate, rubric
-- and scoring rule below is catalogue output, moved and not retyped. Two lines
-- differ: the parameter, and the column in the insert.
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
        raise exception 'the satisfaction rating is the tenant''s — you hold management authority on this request';
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

-- ⚠️ Dropped FIRST, and before the comment below. The three-argument form is
-- not left beside the new one — an optional fourth argument leaves a signature
-- that silently discards a comment a caller passed (0263's lesson, restated by
-- 0270 four files ago) — and while both exist, `comment on function
-- submit_vendor_evaluation` with no argument list is ambiguous and fails the
-- migration on "function name is not unique". 0270 hit the identical wall.
drop function if exists submit_vendor_evaluation(uuid, text, jsonb);

comment on function submit_vendor_evaluation(uuid, text, jsonb, text) is
  'One source''s half of a job''s evaluation: the tenant''s satisfaction, or the FM/PM''s quality and compliance. Optionally carries the evaluator''s own words (0271), which explain a score and never change one — the composite stays the rubric.';

revoke all on function submit_vendor_evaluation(uuid, text, jsonb, text) from public, anon;
grant execute on function submit_vendor_evaluation(uuid, text, jsonb, text) to authenticated, service_role;

-- ── The comment is not a scoring input, asserted rather than promised ────
do $$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'recompute_evaluation_scores';

  if v_def ~ '\mcomment\M' then
    raise exception 'recompute_evaluation_scores now reads the comment — a free-typed sentence must not move a score that gates a payment';
  end if;
end $$;
