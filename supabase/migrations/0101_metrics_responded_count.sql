-- The console needs a headline "average first response", and 0100 cannot honestly
-- produce one.
--
-- ⚠️ `bi_ticket_metrics` returns a per-period `avg_hours_to_first_response` and a
-- `timed` count, but `timed` counts tickets with a RESOLUTION time. Combining the
-- per-period response averages into one figure means weighting each by how many
-- tickets it was averaged over — and weighting the response average by the
-- resolution count is arithmetic on two different populations. A period with 40
-- acknowledged tickets and 2 resolved would contribute as though it had 2.
--
-- The number would look plausible, sit in a headline tile, and be wrong by
-- however much acknowledgement outpaces completion. So the count comes from the
-- database, where it can be counted rather than guessed.
--
-- `create or replace` cannot change a function's return type, hence the drop.

drop function if exists bi_ticket_metrics(date, date, uuid, text, uuid, text, text);

create function bi_ticket_metrics(
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
  -- The population behind `avg_hours_to_first_response`, and NOT the same set as
  -- `timed`: a ticket can be acknowledged and still open.
  responded         bigint,
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
$$;

comment on function bi_ticket_metrics is
  'Ticket volume, completion and durations, bucketed by period and narrowed by any combination of filters. Returns the population behind each average (`timed`, `responded`) so periods can be pooled into a headline without weighting one average by another''s count. Plain SQL over `tickets`, so RLS scopes it — an FM/PM sees only their properties without this function knowing that rule exists.';

revoke all on function bi_ticket_metrics(date, date, uuid, text, uuid, text, text) from public;
grant execute on function bi_ticket_metrics(date, date, uuid, text, uuid, text, text) to authenticated;
