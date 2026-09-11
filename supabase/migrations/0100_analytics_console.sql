-- Day 10. The filterable analytics console.
--
-- ⚠️ ONE function per question, each taking every filter, rather than a view per
-- filter combination. The alternative — a view for "by vendor", another for "by
-- vendor and quarter" — multiplies with each filter added and each copy has to
-- get the scoping right independently. This build already learned that lesson
-- twice: `current_user_property_ids()` is the single scoping resolver because a
-- second one drifted, and the ledger-account resolver was applied in half the
-- places that needed it.
--
-- ⚠️ Every function here is `security_invoker`-equivalent by construction: they
-- are plain SQL over `tickets`, which carries RLS, so an FM/PM sees only their
-- own properties' rows and a tenant only their own. **No function here is
-- SECURITY DEFINER**, deliberately — a definer function would have to re-state
-- the scoping rules, and re-stating them is how they diverge.

-- ── The shared filter shape ───────────────────────────────────────────────
--
-- Every argument is nullable and null means "no filter", so one signature
-- serves the unfiltered console and the most specific drill-down alike.

/**
 * Ticket completion, by whichever dimension is asked for.
 *
 * `p_bucket` is 'week' | 'month' | 'quarter' | 'year' — passed to `date_trunc`,
 * so the period toggle is a parameter rather than four near-identical queries.
 */
create or replace function bi_ticket_metrics(
  p_from       date default null,
  p_to         date default null,
  p_vendor_id  uuid default null,
  p_category   text default null,
  p_property_id uuid default null,
  p_status     text default null,
  p_bucket     text default 'month'
)
returns table (
  period            date,
  total             bigint,
  completed         bigint,
  completion_pct    numeric,
  -- Averaged over tickets that were actually TIMED. Tickets resolved before
  -- `0099` began stamping have no resolution time and are excluded rather than
  -- guessed at, so this reads "of what we measured", never "of everything".
  timed             bigint,
  avg_hours_to_resolve numeric,
  avg_hours_to_first_response numeric
)
language sql stable set search_path = public as $$
  select
    date_trunc(
      case when p_bucket in ('week','month','quarter','year') then p_bucket else 'month' end,
      t.created_at
    )::date                                                          as period,
    count(*)                                                          as total,
    count(*) filter (where t.status in ('resolved','closed'))         as completed,
    round(
      100.0 * count(*) filter (where t.status in ('resolved','closed'))
      / nullif(count(*), 0), 1
    )                                                                 as completion_pct,
    count(*) filter (where t.resolved_at is not null)                 as timed,
    round(
      avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600.0)
        filter (where t.resolved_at is not null)::numeric, 1
    )                                                                 as avg_hours_to_resolve,
    round(
      avg(extract(epoch from (t.first_response_at - t.created_at)) / 3600.0)
        filter (where t.first_response_at is not null)::numeric, 1
    )                                                                 as avg_hours_to_first_response
  from tickets t
  where (p_from is null        or t.created_at >= p_from)
    and (p_to is null          or t.created_at < (p_to + 1))
    and (p_vendor_id is null   or t.assigned_vendor_id = p_vendor_id)
    and (p_category is null    or t.category::text = p_category)
    and (p_property_id is null or t.property_id = p_property_id)
    and (p_status is null      or t.status::text = p_status)
  group by 1
  order by 1;
$$;

comment on function bi_ticket_metrics is
  'Ticket volume, completion and durations, bucketed by period and narrowed by any combination of filters. Plain SQL over `tickets`, so RLS scopes it — an FM/PM sees only their properties without this function knowing that rule exists.';

/**
 * The same figures per vendor, for "who completes fastest".
 *
 * Ordered slowest-last so the console can take the head and tail for
 * best/worst without a second query.
 */
create or replace function bi_vendor_performance(
  p_from        date default null,
  p_to          date default null,
  p_category    text default null,
  p_property_id uuid default null
)
returns table (
  vendor_id uuid,
  vendor_name text,
  total bigint,
  completed bigint,
  completion_pct numeric,
  timed bigint,
  avg_hours_to_resolve numeric
)
language sql stable set search_path = public as $$
  select
    v.id, v.name,
    count(t.id),
    count(t.id) filter (where t.status in ('resolved','closed')),
    round(100.0 * count(t.id) filter (where t.status in ('resolved','closed'))
          / nullif(count(t.id), 0), 1),
    count(t.id) filter (where t.resolved_at is not null),
    round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600.0)
          filter (where t.resolved_at is not null)::numeric, 1)
  from vendors v
  join tickets t on t.assigned_vendor_id = v.id
  where (p_from is null        or t.created_at >= p_from)
    and (p_to is null          or t.created_at < (p_to + 1))
    and (p_category is null    or t.category::text = p_category)
    and (p_property_id is null or t.property_id = p_property_id)
  group by v.id, v.name
  -- Nulls last: a vendor with nothing timed is not the fastest, it is unmeasured.
  order by avg(extract(epoch from (t.resolved_at - t.created_at))) asc nulls last;
$$;

comment on function bi_vendor_performance is
  'Per-vendor completion and speed. Ordered fastest-first with unmeasured vendors LAST — a vendor with no timed tickets is not the quickest, it is simply unknown, and sorting nulls first would crown it.';

/** Completion by classification, for the category breakdown. */
create or replace function bi_category_performance(
  p_from        date default null,
  p_to          date default null,
  p_vendor_id   uuid default null,
  p_property_id uuid default null
)
returns table (
  category text,
  total bigint,
  completed bigint,
  completion_pct numeric,
  avg_hours_to_resolve numeric
)
language sql stable set search_path = public as $$
  select
    coalesce(t.category::text, 'unclassified'),
    count(*),
    count(*) filter (where t.status in ('resolved','closed')),
    round(100.0 * count(*) filter (where t.status in ('resolved','closed'))
          / nullif(count(*), 0), 1),
    round(avg(extract(epoch from (t.resolved_at - t.created_at)) / 3600.0)
          filter (where t.resolved_at is not null)::numeric, 1)
  from tickets t
  where (p_from is null        or t.created_at >= p_from)
    and (p_to is null          or t.created_at < (p_to + 1))
    and (p_vendor_id is null   or t.assigned_vendor_id = p_vendor_id)
    and (p_property_id is null or t.property_id = p_property_id)
  group by 1
  order by count(*) desc;
$$;

revoke all on function bi_ticket_metrics(date, date, uuid, text, uuid, text, text) from public;
revoke all on function bi_vendor_performance(date, date, text, uuid) from public;
revoke all on function bi_category_performance(date, date, uuid, uuid) from public;

grant execute on function bi_ticket_metrics(date, date, uuid, text, uuid, text, text) to authenticated;
grant execute on function bi_vendor_performance(date, date, text, uuid) to authenticated;
grant execute on function bi_category_performance(date, date, uuid, uuid) to authenticated;

-- ── The tenant's own request tracker ──────────────────────────────────────
--
-- A tenant has no read on `properties` or `vendors` (0056 onwards), so the same
-- denormalised, definer-scoped shape `my_tenancies()` uses applies here: the
-- caller sees their own requests with readable labels, without being granted
-- access to the registers those labels come from.
create or replace function my_requests()
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
  assigned_to text
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
    v.name
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
  'The caller''s own requests with a readable timeline. Definer-scoped to auth.uid() because a tenant has no read on vendors or properties — and should not need one to follow their own leaking tap.';
