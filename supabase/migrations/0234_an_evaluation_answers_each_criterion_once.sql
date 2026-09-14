-- An evaluation answers each criterion once, and the guard that said so was
-- never finished.
--
-- `submit_vendor_evaluation` reads one response per criterion with
--
--     select value_obj into v_line from (jsonb_array_elements(p_responses)) x
--      where (value_obj->>'criterionId')::uuid = crit.id
--      limit 1;
--
-- — `limit 1`, no `order by`, over a caller-supplied JSON array. A payload
-- naming the same `criterionId` twice with different values therefore scores
-- whichever element the executor returns first. That is not a display defect:
-- the result is written to `evaluation_responses`, summed into the quality,
-- compliance and satisfaction dimensions, and the composite is what B4 makes a
-- **gate on paying a vendor** — "no transfer executes unless verification and
-- evaluation gates pass". A score that depends on row order is not a gate.
--
-- 📌 **The guard was started and abandoned in place.** `v_seen_criteria` is
-- declared, appended to on every iteration, and **never read** — by anything,
-- anywhere. It is exactly the shape of a duplicate check, which is why the
-- defect survived three later migrations touching this function (`0197`,
-- `0220`): a reader who greps for the concern finds a variable that appears to
-- track it. A half-written guard is worse than no guard, because no guard is
-- visibly absent. It is removed here rather than completed — the check belongs
-- before the loop, on the payload, not accumulated during it.
--
-- Refused, not de-duplicated, and not "last one wins": the same line `0225`
-- drew when a lease's unit and property disagreed. Two contradictory answers to
-- one question are the submitter's to resolve, and silently keeping one of them
-- is how the wrong number becomes evidence.
--
-- ⚠️ A response naming a criterion that is not in the active set is still
-- ignored, deliberately. The loop is scoped to the dimensions being evaluated
-- (`dimension = any (v_dims)`), so a client that posts every dimension's answers
-- and has only some read is behaving correctly, not making an error.
--
-- Rewritten MECHANICALLY from the live catalogue via `pg_get_functiondef`, per
-- `0183`'s rule — this body carries the payment-gating arithmetic, and a clause
-- lost to retyping is a money bug. The only edits are the guard inserted above
-- the manual-criteria loop and the removal of the dead variable.

CREATE OR REPLACE FUNCTION public.submit_vendor_evaluation(p_ticket_id uuid, p_source text, p_responses jsonb)
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

  insert into vendor_evaluations (org_id, vendor_id, ticket_id, source, evaluated_by)
  values (v_org, v_vendor, p_ticket_id, p_source, auth.uid())
  returning id into v_eval;

  -- ⚠️ Two answers to one question is not an answer. The loop below reads
  -- ONE response per criterion with `limit 1` and no `order by`, so a payload
  -- naming the same criterionId twice scored whichever row the executor
  -- happened to return -- on a composite that gates a vendor payment (B4: no
  -- payment without performance validation). Refused rather than de-duplicated,
  -- for 0225's reason: two contradictory statements about one fact, and only
  -- the person submitting them knows which is right.
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

revoke all on function submit_vendor_evaluation(uuid, text, jsonb) from public;
revoke execute on function submit_vendor_evaluation(uuid, text, jsonb) from anon;
grant execute on function submit_vendor_evaluation(uuid, text, jsonb) to authenticated, service_role;

comment on function submit_vendor_evaluation is
  'Scores a vendor against the active rubric for one ticket. Each criterion takes exactly one response: a payload naming the same criterion twice is REFUSED, where until 0234 it was scored on whichever duplicate the executor returned first -- on the composite that gates a vendor payment (B4).';
