-- `day` becomes a real bucket, instead of quietly becoming `month`.
--
-- ⚠️ `bi_ticket_metrics` CLAMPS an unrecognised bucket:
--
--     case when p_bucket in ('week','month','quarter','year')
--          then p_bucket else 'month' end
--
-- which is a sensible guard — `p_bucket` reaches `date_trunc` as a UNIT NAME,
-- and an allow-list is what stops it being anything else. It also means asking
-- for a day silently returns MONTHS. The drill chart would have been drawn
-- correctly for the wrong grouping, under a heading that said days: wrong
-- quietly, which is the worst way for a figure to be wrong.
--
-- The drill path the board asked for is month → week → day (Task 4), so `day`
-- has to be a value the clamp ADMITS rather than one it swallows. That is the
-- whole change: one more literal in the allow-list. The clamp itself stays, and
-- the temptation to "just pass p_bucket through" is why this note exists.
--
-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`), per the 0136
-- lesson — and that mattered here. The first draft of this migration was
-- reconstructed from the function's shape rather than its text, and would have
-- returned `period` as TEXT instead of DATE: a changed return type, which
-- `create or replace` refuses outright, and which would have broken every
-- caller had it been forced through with a DROP. The body below is byte-for-byte
-- the live one apart from line 9's allow-list.

create or replace function bi_ticket_metrics(
  p_from date default null::date,
  p_to date default null::date,
  p_vendor_id uuid default null::uuid,
  p_category text default null::text,
  p_property_id uuid default null::uuid,
  p_status text default null::text,
  p_bucket text default 'month'::text
)
returns table (
  period date,
  total bigint,
  completed bigint,
  completion_pct numeric,
  timed bigint,
  avg_hours_to_resolve numeric,
  responded bigint,
  avg_hours_to_first_response numeric
)
language sql stable set search_path to 'public' as $function$
  select
    date_trunc(
      case when p_bucket in ('day','week','month','quarter','year') then p_bucket else 'month' end,
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
    count(*) filter (where t.first_response_at is not null)           as responded,
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
$function$;

comment on function bi_ticket_metrics is
  'Request volume and speed per period, under the caller''s own RLS. p_bucket is ALLOW-LISTED before reaching date_trunc — it is a unit name, not a value — and since 0160 the list includes ''day'', so the month → week → day drill groups by what it says it does rather than falling back to months.';
