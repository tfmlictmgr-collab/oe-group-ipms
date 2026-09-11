-- A tenant-source rating must come from a tenant.
--
-- ⚠️ THE CONSEQUENCE OF 0218, closed in the same breath rather than left.
--
-- 0218 made `raise_work_order` stamp `sender_id` so an FM/PM can find the work
-- they raised — the board's ask, and the reason "Raised by me" was empty. But
-- standing to file the TENANT half of 0104's rubric was `t.sender_id =
-- auth.uid()`, which was a safe proxy only while a sender was always a tenant.
--
-- It was already not always a tenant: `app/dashboard/new/actions.ts` has always
-- stamped whoever submitted the form, an FM included. 0218 makes that ordinary
-- rather than incidental, so the proxy has to be replaced by the thing it was
-- standing in for.
--
-- Left alone, an FM could file a SATISFACTION score on their own work order —
-- a contractor's tenant rating, written by the person who commissioned the job,
-- feeding the composite score that `min_performance_score` gates payment on.
-- Narrow, and squarely in the one place this system refuses to let a party mark
-- their own homework.
--
-- 📌 `verify-fm-journey` asserted `sender_id is null` and gave this exact
-- reason — "a non-null one would wrongly arm the tenant satisfaction prompt".
-- The assertion was defending a real invariant through an incidental fact. The
-- invariant is kept and stated directly; the fact is no longer required to
-- carry it.
--
-- The UI half moved with 0218: `isTenant` on the ticket page now means "the
-- reporter who does NOT hold management authority", so an FM is offered the
-- quality/compliance form. This is the database saying the same thing, for the
-- callers that never go through that page.
--
-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`). One branch
-- gains one guard; every other byte is what was running.

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
  v_seen_criteria uuid[] := '{}';
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

    v_seen_criteria := array_append(v_seen_criteria, crit.id);
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
