-- Day 11 — KPI/SLA-driven, dual-source vendor evaluation.
-- Spec: docs/PHASE1_VENDOR_EVALUATION.md.
--
-- ⚠️ Replaces the free-typed evaluation form entirely. `EvaluationForm.tsx`
-- let an FM/PM type five 0–100 numbers and insert them directly — nothing
-- computed, nothing evidenced, one evaluator only. The spec's own words: "Scores
-- must not be arbitrary — evaluators answer an agreed KPI/SLA checklist... the
-- score is computed from the responses, not free-typed."
--
-- Design, per the spec's own recommended mapping onto the existing AURA weights
-- (Quality 30 · Response 20 · Completion 20 · Satisfaction 20 · Compliance 10):
--   • Quality + Compliance  — FM/PM answers a checklist on job completion.
--   • Satisfaction          — the TENANT who raised the request answers a
--                             checklist of their own. "Customer Satisfaction"
--                             already IS the tenant's voice in the AURA model —
--                             this is not a third source, it's naming the
--                             existing weight correctly.
--   • Response + Completion — auto-measured against an admin-set SLA target
--                             from `tickets.first_response_at`/`resolved_at`.
--                             Zero human input, zero arbitrariness, and it's
--                             the strongest anti-arbitrary design available:
--                             a checklist item can still be gamed by a lenient
--                             evaluator; a timestamp cannot.
--
-- ⚠️ One evaluation EVENT per completed ticket, stored as up to TWO immutable
-- rows (`source = 'fm_pm'` / `'tenant'`) rather than one row updated in two
-- stages. `vendor_evaluations` already has no UPDATE policy — evaluations are
-- append-only, same ethos as the ledger ("corrections are reversing entries,
-- never edits") — and two inserts preserve that rather than fighting it. The
-- COMBINED composite is a view, computed only once both sources exist, never
-- stored: the same "derived from postings, never stored" reasoning `ledger_
-- account_balances` already uses, so a composite can never disagree with the
-- responses behind it.
--
-- ⚠️ Criteria are EFFECTIVE-DATED, not edited in place. Changing a checklist
-- item's points must not retroactively reinterpret an evaluation already
-- submitted against the old wording/weight — same "snapshot, not reference"
-- principle already used for the management fee (decision 14). Editing a
-- criterion supersedes it with a new row; `evaluation_responses` keeps pointing
-- at the exact criterion version that was actually answered.

-- ── The rubric ───────────────────────────────────────────────────────────

create type eval_dimension as enum ('quality', 'response', 'completion', 'satisfaction', 'compliance');
create type eval_measure as enum ('manual', 'auto');
create type eval_response_type as enum ('met_partial_not_met', 'yes_no', 'scale_1_5');

create table evaluation_criteria (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,

  dimension eval_dimension not null,
  label text not null,

  -- 'manual' — a checklist item a human answers (quality, compliance, satisfaction).
  -- 'auto'   — measured from ticket timestamps against sla_target_hours
  --            (response, completion). No evaluator, no response row.
  measure eval_measure not null default 'manual',
  response_type eval_response_type,
  sla_target_hours numeric(6,2),

  max_points numeric(6,2) not null check (max_points > 0),
  active boolean not null default true,
  sort_order int not null default 0,

  -- Effective-dating. A new version supersedes the old one; the old one stays
  -- exactly as it was for anything that already answered it.
  effective_from timestamptz not null default now(),
  superseded_by uuid references evaluation_criteria(id),

  created_by uuid references users(id),
  created_at timestamptz not null default now(),

  constraint eval_criteria_manual_shape
    check ((measure = 'manual') = (response_type is not null)),
  constraint eval_criteria_auto_shape
    check ((measure = 'auto') = (sla_target_hours is not null))
);

create index evaluation_criteria_org_dim_idx on evaluation_criteria (org_id, dimension) where active;

alter table evaluation_criteria enable row level security;

-- Anyone in the org may READ the active rubric — a tenant has to see the
-- satisfaction questions to answer them, and there is nothing sensitive in a
-- checklist's wording. Only an admin may WRITE it (the spec names "admin"
-- explicitly; matches the existing hardwired pattern for fee/banking settings
-- rather than a new B7 capability).
create policy evaluation_criteria_select on evaluation_criteria for select
  using (org_id = current_user_org_id());

create policy evaluation_criteria_write on evaluation_criteria for insert
  with check (org_id = current_user_org_id() and current_user_role() = 'admin');

-- No UPDATE policy: a criterion is superseded, never edited, for the same
-- reason the ledger has no UPDATE policy — the trail must show what actually
-- changed, not silently become something else.

create trigger audit_evaluation_criteria after insert on evaluation_criteria
  for each row execute function log_audit('evaluation_criteria.write');

comment on table evaluation_criteria is
  'The admin-editable KPI/SLA rubric. Effective-dated: editing supersedes with a new row rather than mutating the old one, so a past evaluation is never retroactively rescored.';

/**
 * Supersedes an existing criterion with an edited version, in one transaction.
 * SECURITY DEFINER so the caller needs no direct table grant; the admin check
 * happens here rather than relying on two separate RLS-gated statements
 * (insert-then-update) that could partially apply.
 */
create or replace function edit_evaluation_criterion(
  p_old_id uuid,
  p_label text,
  p_max_points numeric,
  p_response_type eval_response_type default null,
  p_sla_target_hours numeric default null,
  p_sort_order int default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  old evaluation_criteria%rowtype;
  v_new uuid;
begin
  select * into old from evaluation_criteria where id = p_old_id;
  if old.id is null then
    raise exception 'that criterion could not be found';
  end if;
  if auth.uid() is not null then
    if old.org_id is distinct from current_user_org_id() then
      raise exception 'that criterion belongs to another organisation';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator may edit the evaluation rubric';
    end if;
  end if;
  if old.superseded_by is not null then
    raise exception 'that criterion has already been superseded — edit the current version instead';
  end if;

  insert into evaluation_criteria (
    org_id, dimension, label, measure, response_type, sla_target_hours,
    max_points, sort_order, created_by
  ) values (
    old.org_id, old.dimension, p_label, old.measure,
    coalesce(p_response_type, old.response_type),
    coalesce(p_sla_target_hours, old.sla_target_hours),
    p_max_points, coalesce(p_sort_order, old.sort_order), auth.uid()
  )
  returning id into v_new;

  update evaluation_criteria set superseded_by = v_new, active = false where id = p_old_id;

  return v_new;
end;
$$;

revoke all on function edit_evaluation_criterion(uuid, text, numeric, eval_response_type, numeric, int) from public;
grant execute on function edit_evaluation_criterion(uuid, text, numeric, eval_response_type, numeric, int) to authenticated;

/** Retires a criterion without replacing it (a checklist genuinely shrinking). */
create or replace function retire_evaluation_criterion(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  crit evaluation_criteria%rowtype;
begin
  select * into crit from evaluation_criteria where id = p_id;
  if crit.id is null then raise exception 'that criterion could not be found'; end if;
  if auth.uid() is not null then
    if crit.org_id is distinct from current_user_org_id() then
      raise exception 'that criterion belongs to another organisation';
    end if;
    if current_user_role() is distinct from 'admin' then
      raise exception 'only an administrator may edit the evaluation rubric';
    end if;
  end if;
  update evaluation_criteria set active = false where id = p_id;
end;
$$;

revoke all on function retire_evaluation_criterion(uuid) from public;
grant execute on function retire_evaluation_criterion(uuid) to authenticated;

/**
 * Seeds the default rubric for an org, mirroring `ensure_default_ledger_
 * accounts` — idempotent, callable on demand. Points within each MANUAL
 * dimension sum to 100, so "dimension score = Σ points_awarded" needs no
 * further scaling; AUTO dimensions are scored 0–100 directly by formula.
 */
create or replace function ensure_default_evaluation_criteria(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if current_user_role() is distinct from 'admin'
     or current_user_org_id() is distinct from p_org_id then
    if auth.uid() is not null then
      raise exception 'only an administrator of this organisation may set up the evaluation rubric';
    end if;
  end if;

  if exists (select 1 from evaluation_criteria where org_id = p_org_id) then
    return;
  end if;

  insert into evaluation_criteria (org_id, dimension, label, measure, response_type, max_points, sort_order, created_by)
  values
    (p_org_id, 'quality', 'The work was completed to a professional standard', 'manual', 'met_partial_not_met', 60, 10, auth.uid()),
    (p_org_id, 'quality', 'No rework or follow-up visit was required', 'manual', 'yes_no', 40, 11, auth.uid()),
    (p_org_id, 'compliance', 'The vendor followed the site''s safety/PPE requirements', 'manual', 'met_partial_not_met', 50, 20, auth.uid()),
    (p_org_id, 'compliance', 'Required documentation (permit/certificate) was provided where applicable', 'manual', 'yes_no', 50, 21, auth.uid()),
    (p_org_id, 'satisfaction', 'How satisfied are you with how this request was handled?', 'manual', 'scale_1_5', 70, 30, auth.uid()),
    (p_org_id, 'satisfaction', 'Was the work completed properly the first time?', 'manual', 'yes_no', 30, 31, auth.uid());

  insert into evaluation_criteria (org_id, dimension, label, measure, sla_target_hours, max_points, sort_order, created_by)
  values
    (p_org_id, 'response', 'First response within target', 'auto', 4, 100, 40, auth.uid()),
    (p_org_id, 'completion', 'Job completed within target', 'auto', 48, 100, 50, auth.uid());
end;
$$;

revoke all on function ensure_default_evaluation_criteria(uuid) from public;
grant execute on function ensure_default_evaluation_criteria(uuid) to authenticated, service_role;

-- ── Evaluations ──────────────────────────────────────────────────────────
--
-- Extends the existing table (0001) rather than replacing it, so historical
-- free-typed rows (period-based, pre-Day-11) stay exactly as they were —
-- append-only history is not rewritten because the submission method changed.
alter table vendor_evaluations add column if not exists ticket_id uuid references tickets(id);
alter table vendor_evaluations add column if not exists source text check (source in ('tenant', 'fm_pm'));

-- One row per (ticket, source) — a tenant or an FM/PM can each say their part
-- exactly once for a given job.
create unique index if not exists vendor_evaluations_ticket_source_uidx
  on vendor_evaluations (ticket_id, source) where ticket_id is not null;

comment on column vendor_evaluations.ticket_id is
  'The completed job this evaluation is FOR. Null on legacy free-typed period entries (pre-Day-11) — those remain valid history, never rewritten.';
comment on column vendor_evaluations.source is
  'Which half of the dual-source evaluation this row is: tenant (satisfaction only) or fm_pm (quality/compliance/response/completion). A ticket has at most one of each — see the unique index.';

create table evaluation_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  evaluation_id uuid not null references vendor_evaluations(id) on delete cascade,
  criterion_id uuid not null references evaluation_criteria(id),
  response_value text not null,
  points_awarded numeric(6,2) not null,
  created_at timestamptz not null default now(),
  unique (evaluation_id, criterion_id)
);

create index evaluation_responses_evaluation_idx on evaluation_responses (evaluation_id);

alter table evaluation_responses enable row level security;

-- Same visibility as the evaluation they belong to.
create policy evaluation_responses_select on evaluation_responses for select
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from vendor_evaluations ve
       where ve.id = evaluation_responses.evaluation_id
         and (
           current_user_role() = any (oversight_roles())
           or ve.vendor_id in (select id from vendors where user_id = auth.uid())
           or (current_user_role() = any (fm_roles())
               and ve.vendor_id in (select current_user_scoped_vendor_ids()))
         )
    )
  );

-- No INSERT policy at all: written only by submit_vendor_evaluation() below,
-- which computes points_awarded itself rather than trusting a client-supplied
-- figure — the exact reasoning payments/collections already apply to money.

comment on table evaluation_responses is
  'One answer to one rubric item. points_awarded is computed server-side by submit_vendor_evaluation(), never accepted from the caller — a free-typed point value is exactly the arbitrariness this feature exists to remove.';

-- ── The one write path ──────────────────────────────────────────────────
--
-- `vendor_evaluations_write` (0052) let ANY holder of `vendors.evaluate` insert
-- an arbitrary row with arbitrary scores. That is retired: every evaluation now
-- goes through this function, which validates the ticket, the caller's standing
-- to evaluate it, and computes every score from actual responses/timestamps —
-- the client can propose response VALUES ('met', 'yes', '4') but never a point
-- total or a dimension score.
drop policy if exists vendor_evaluations_write on vendor_evaluations;

/**
 * Records one source's half of a ticket's evaluation.
 *
 * p_responses: [{"criterionId": uuid, "value": "met"|"partial"|"not_met"|"yes"|"no"|"1".."5"}, ...]
 * — one entry per active MANUAL criterion for this source's dimensions. Auto
 * dimensions (response/completion) need no entry; they are computed here from
 * the ticket's own timestamps against whichever criterion was ACTIVE at the
 * ticket's resolution — not whichever is active today, so a later SLA-target
 * change never rewrites a past job's score.
 */
create or replace function submit_vendor_evaluation(
  p_ticket_id uuid,
  p_source text,
  p_responses jsonb
)
returns uuid language plpgsql security definer set search_path = public as $$
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
$$;

revoke all on function submit_vendor_evaluation(uuid, text, jsonb) from public;
grant execute on function submit_vendor_evaluation(uuid, text, jsonb) to authenticated, service_role;

comment on function submit_vendor_evaluation(uuid, text, jsonb) is
  'The only way to write a vendor evaluation. Validates the ticket is complete, checks the caller''s standing for the source they claim (tenant = the request''s own sender; fm_pm = oversight or the vendor''s FM), and computes every score itself — response/completion from ticket timestamps against the SLA target active when the job resolved, quality/compliance/satisfaction from the fixed response-type point mapping. No score is ever accepted from the caller.';

-- ── The combined composite ──────────────────────────────────────────────
--
-- One row per ticket that has AT LEAST one source submitted; a composite is
-- populated only once BOTH sources exist — a missing dimension is not
-- estimated, averaged around, or defaulted to zero. This is the same
-- discipline `bi_ticket_metrics` (Day 10) applies to timing averages: report
-- what was actually measured, say plainly when something has not been.
create or replace view vendor_evaluation_tickets as
  with fm as (
    select * from vendor_evaluations where source = 'fm_pm'
  ), tn as (
    -- ⚠️ Pre-filtered in a CTE, not `fm.source = 'fm_pm' and tn.source =
    -- 'tenant'` inside the ON clause. Putting the source check in the join
    -- condition instead of the row source means a 'tenant' row fails to match
    -- as "fm" and appears a SECOND time as an unmatched fm-side row (all tn.*
    -- null) alongside its correct appearance as tn — every row double-counted.
    -- Filtering each side to exactly one source before the join is what makes
    -- this a clean 1:1 match per ticket.
    select * from vendor_evaluations where source = 'tenant'
  )
  select
    coalesce(fm.ticket_id, tn.ticket_id) as ticket_id,
    coalesce(fm.org_id, tn.org_id) as org_id,
    coalesce(fm.vendor_id, tn.vendor_id) as vendor_id,
    fm.id as fm_pm_evaluation_id,
    tn.id as tenant_evaluation_id,
    fm.quality_score, fm.response_score, fm.completion_score, fm.compliance_score,
    tn.satisfaction_score,
    fm.created_at as fm_pm_submitted_at,
    tn.created_at as tenant_submitted_at,
    case
      when fm.id is not null and tn.id is not null then
        round(
          fm.quality_score * 0.30 + fm.response_score * 0.20 + fm.completion_score * 0.20
          + tn.satisfaction_score * 0.20 + fm.compliance_score * 0.10
        , 1)
      else null
    end as composite_score,
    (fm.id is not null and tn.id is null) as awaiting_tenant,
    (fm.id is null and tn.id is not null) as awaiting_fm_pm
  from fm
  full outer join tn on tn.ticket_id = fm.ticket_id
  where coalesce(fm.ticket_id, tn.ticket_id) is not null;

alter view vendor_evaluation_tickets set (security_invoker = on);

comment on view vendor_evaluation_tickets is
  'One row per completed job that has at least one evaluation source submitted. composite_score is populated ONLY when both fm_pm and tenant have submitted — the AURA weights (Quality 30 / Response 20 / Completion 20 / Satisfaction 20 / Compliance 10) applied to a genuinely complete pair, never estimated from a partial one.';

-- ── Prompt the tenant when their job is done ────────────────────────────────
--
-- A SEPARATE `after update` trigger, not folded into `tickets_stamp_lifecycle()`
-- (0099, `before update`). That trigger sets timestamps and must not be made to
-- also depend on `user_notifications` existing or `notify_user()` succeeding —
-- a notification failing should never be able to block the status transition
-- it is merely announcing. Two triggers, two concerns, neither can break the
-- other.
create or replace function tickets_prompt_review()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status in ('resolved', 'closed')
     and old.status not in ('resolved', 'closed')
     and new.sender_id is not null
     and new.assigned_vendor_id is not null then
    perform notify_user(
      new.sender_id,
      'request',
      'How did we do?',
      coalesce(new.summary, left(new.message_text, 80)) || ' has been marked complete — rate the work when you have a moment.',
      '/dashboard/tickets/' || new.id,
      'ticket', new.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_review_prompt on tickets;
create trigger tickets_review_prompt after update on tickets
  for each row execute function tickets_prompt_review();

comment on function tickets_prompt_review is
  'Notifies the tenant once, on first arrival at resolved/closed, that their job is ready to be rated. Separate from tickets_stamp_lifecycle (0099) so a notification fault can never block the status transition itself.';

-- ── my_requests() learns whether a review is waiting ────────────────────────
--
-- A tenant cannot read `vendor_evaluations` directly — `vendor_evaluations_
-- select` (0001/0078a) admits oversight roles, a vendor's own rows, or an
-- FM/PM's scoped vendors; a TENANT is none of those, by design (they are owed
-- their OWN request's progress, not a vendor's file). So the only way for the
-- tracker to know "have I already rated this" is for this SECURITY DEFINER
-- function to say so itself, exactly as it already does for the vendor's name.
--
-- `drop` first: Postgres refuses to change a RETURNS TABLE shape via `create or
-- replace`, the same rule that applies to views (0103 already ran into this).
drop function if exists my_requests();

create function my_requests()
returns table (
  ticket_id uuid,
  summary text,
  category text,
  urgency text,
  status text,
  created_at timestamptz,
  first_response_at timestamptz,
  resolved_at timestamptz,
  hours_open numeric,
  assigned_to text,
  awaiting_review boolean
)
language sql stable security definer set search_path = public as $$
  select
    t.id,
    coalesce(t.summary, left(t.message_text, 120)),
    coalesce(t.category::text, 'unclassified'),
    coalesce(t.urgency::text, 'normal'),
    t.status::text,
    t.created_at,
    t.first_response_at,
    t.resolved_at,
    round(extract(epoch from (coalesce(t.resolved_at, now()) - t.created_at)) / 3600.0, 1),
    -- The vendor's name only. Not who dispatched it, not internal notes — a
    -- tenant is owed progress on their own request, not the org's workings.
    v.name,
    -- Done, has a vendor to rate, and no tenant-source row exists yet.
    (
      t.status in ('resolved', 'closed')
      and t.assigned_vendor_id is not null
      and not exists (
        select 1 from vendor_evaluations ve
         where ve.ticket_id = t.id and ve.source = 'tenant'
      )
    )
  from tickets t
  left join vendors v on v.id = t.assigned_vendor_id
  -- The whole boundary, in one line: this is SECURITY DEFINER, so this WHERE is
  -- the only thing between a caller and every ticket in the database.
  where t.sender_id = auth.uid()
  order by t.created_at desc;
$$;

revoke all on function my_requests() from public;
grant execute on function my_requests() to authenticated;

comment on function my_requests is
  'The caller''s own requests with a readable timeline. Definer-scoped to auth.uid() because a tenant has no read on vendors or properties — and should not need one to follow their own leaking tap. awaiting_review (0104) is here for the same reason: a tenant has no read on vendor_evaluations either, so this is the only way the tracker can know whether their review is still outstanding.';
