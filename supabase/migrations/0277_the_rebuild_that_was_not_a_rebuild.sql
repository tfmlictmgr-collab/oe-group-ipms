-- The rebuild that was not a rebuild (8 Sept 2026).
--
-- ⚠️ `submit_vendor_evaluation` has been **completely non-functional since
-- 0271**. Not degraded — no evaluation of any kind, from any source, in any
-- organisation, could be submitted at all. And B4 is explicit that no vendor
-- payment executes without a performance evaluation, so the one thing standing
-- between a contractor and their money has been raising an error for anybody
-- who tried to clear it.
--
-- Three separate faults, all of them the same act:
--
--   1. It inserts into `evaluation_responses (… value, points)`. Those columns
--      have never existed. `0104` created the table with **`response_value`**
--      and **`points_awarded`**, and has never been altered. Every call dies
--      on `column "value" of relation "evaluation_responses" does not exist`.
--   2. It calls **`recompute_evaluation_scores(v_eval)`**, which **does not
--      exist and never has** — it is named in no migration but 0271 and 0274.
--      `0234`'s body computed the scores inline: the manual dimensions from
--      the points actually awarded, and the response/completion dimensions
--      from the ticket's own timestamps against the SLA target that was active
--      when it resolved. All of that was deleted and replaced by a call to
--      something imagined.
--   3. It **silently reverted `0234`**, whose entire subject was refusing a
--      payload that answers one criterion twice — "two answers to one question
--      is not an answer", on a composite that gates a payment. The check is
--      simply absent from 0271's body.
--
-- 📌 **This is 0183's rule failing in the worst possible way, and 0274 walked
-- straight past it.** 0271's header claimed its body was catalogue output,
-- "moved and not retyped". It was not: it was written from memory, and the
-- memory was wrong about a table's column names, invented a helper, and
-- dropped a control added eleven days earlier. 0274 was written specifically
-- because 0271 had retyped ONE line — and it verified only that line, asserted
-- only that line, and carried the rest of the damage forward unread. **A fix
-- aimed at the instance rather than the class is how the class survives.**
--
-- 📌 And the suite estate did catch it — the day the full run was next done.
-- `verify-vendor-journey`, `verify-vendor-score-consumers` and
-- `verify-fm-journey` all passed throughout, because the first two write
-- through the service role into the tables directly and the third exercises
-- only the REFUSAL path, which returns before the insert. Exactly the fault
-- 0216's note names: **a suite that proves the policy and never sits in the
-- user's seat.** `verify-vendor-evaluation` calls the RPC, and it is the one
-- that went red.
--
-- ── What this restores ────────────────────────────────────────────────────
--
-- `0234`'s body, byte-for-byte from the migration that last correctly defined
-- it, with EXACTLY the three additions 0271 actually intended and nothing
-- else: the `p_comment` parameter, its length guard, and `comment` on the
-- insert into `vendor_evaluations`. The tenant-source guard keeps 0274's
-- restored wording, which is 0234's own. `v_seen_criteria` — declared by 0271,
-- appended to, and never read — is gone with the rest.
--
-- The 4-argument signature is already the only one in the catalogue (0271
-- dropped the 3-argument version), so this is a replace and not a re-create.

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
  -- 0271's genuine addition: the evaluator's own words, which explain a score
  -- and never change one — the composite stays the rubric.
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
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

  insert into vendor_evaluations (org_id, vendor_id, ticket_id, source, evaluated_by, comment)
  values (v_org, v_vendor, p_ticket_id, p_source, auth.uid(), v_comment)
  returning id into v_eval;

  -- ⚠️ Two answers to one question is not an answer. The loop below reads
  -- ONE response per criterion with `limit 1` and no `order by`, so a payload
  -- naming the same criterionId twice scored whichever row the executor
  -- happened to return -- on a composite that gates a vendor payment (B4: no
  -- payment without performance validation). Refused rather than de-duplicated,
  -- for 0225's reason: two contradictory statements about one fact, and only
  -- the person submitting them knows which is right.
  --
  -- 📌 0234 added this and 0271 deleted it without noticing. Restored here.
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

comment on function submit_vendor_evaluation(uuid, text, jsonb, text) is
  'One source''s half of a job''s evaluation: the tenant''s satisfaction, or the FM/PM''s quality and compliance. Scores are computed here — manual dimensions from the points awarded, response and completion from the ticket''s own timestamps against the SLA target active when it resolved. Optionally carries the evaluator''s own words (0271), which explain a score and never change one. Restored in full by 0277 after 0271 replaced the body with one that named columns that do not exist, called a function that does not exist, and dropped 0234''s duplicate-criterion refusal.';

-- ⚠️ `create or replace` re-applies Supabase's default grants — the wound
-- 0204/0209/0210/0264 have now recorded four times, and `authenticated` is the
-- half the reflex misses.
revoke all on function submit_vendor_evaluation(uuid, text, jsonb, text) from public, anon;
grant execute on function submit_vendor_evaluation(uuid, text, jsonb, text) to authenticated, service_role;

-- ── Assert the body against the SCHEMA, not against a reading ─────────────
--
-- The whole failure was a body that referenced names nothing checked. Three
-- assertions, each aimed at one of the three faults, so a future rebuild that
-- reintroduces any of them fails here rather than in production:
--
--   * every column the body writes actually exists on the table it writes to;
--   * every function the body calls actually exists;
--   * 0234's control is present.
do $$
declare
  v_def text;
  v_missing text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_vendor_evaluation';

  -- 1. The columns it writes must exist. Asked of the catalogue rather than
  --    matched as a string, because "the body mentions response_value" is not
  --    the same claim as "response_value is a column".
  foreach v_missing in array array['response_value', 'points_awarded'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'evaluation_responses'
         and column_name = v_missing
    ) then
      raise exception 'evaluation_responses has no column %', v_missing;
    end if;
    if v_def !~ v_missing then
      raise exception 'submit_vendor_evaluation does not write evaluation_responses.%', v_missing;
    end if;
  end loop;

  -- 2. Nothing imagined. `recompute_evaluation_scores` is the specific ghost
  --    0271 invented; the rule is the general one.
  if v_def ~ 'recompute_evaluation_scores' then
    raise exception
      'submit_vendor_evaluation still calls recompute_evaluation_scores, which does not exist';
  end if;

  -- 3. 0234's control, and 0220/0274's wording, both of which a rebuild has
  --    now lost once each.
  if v_def !~ 'answers the same criterion more than once' then
    raise exception 'submit_vendor_evaluation has lost 0234''s duplicate-criterion refusal';
  end if;
  if v_def !~ 'satisfaction rating belongs to the tenant who reported this' then
    raise exception 'submit_vendor_evaluation no longer carries the established tenant-guard wording';
  end if;

  -- 4. And the scoring is done here, not deferred to nothing.
  if v_def !~ 'satisfaction_score' or v_def !~ 'completion_score' then
    raise exception 'submit_vendor_evaluation no longer computes the dimension scores';
  end if;
end $$;
