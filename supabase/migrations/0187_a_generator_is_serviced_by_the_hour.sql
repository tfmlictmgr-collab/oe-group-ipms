-- A generator is not serviced on a calendar. It is serviced on its hour meter.
-- (Board direction, 21 Aug 2026.)
--
-- 0121 added `maintenance_strategy` with three values and wired only two of
-- them. Its own comment says so plainly:
--
--     usage: meter/hours-based -- PHASE 2. The value exists in the check
--     constraint so the column never needs widening when meters/sensor_readings
--     land, but nothing sets it and no UI offers it until they do.
--
-- That seam is now being used, and deliberately WITHOUT waiting for the IoT
-- work. B9 reserves `meters` and `sensor_readings` for Phase 2 telemetry — a
-- Shelly EM reporting itself. What a Nigerian FM needs today is the number
-- painted on the front of the generator, read off it during a site visit and
-- typed in. Those are different problems: one is an integration, the other is a
-- field. Making the field wait for the integration is how a register stays
-- honest about nothing.
--
-- ⚠️ Running hours are what actually governs plant here. A 500-hour service
-- interval is roughly six weeks of grid instability and roughly nine months of
-- standby duty, and a calendar cannot tell those apart. Servicing a generator
-- by date either wastes half the oil changes or destroys the engine.
--
-- ── What is deliberately NOT built ────────────────────────────────────────
--
-- No automatic work-order raising when a threshold is crossed. `raise_work_order`
-- (0120) is how planned work is created and it requires a human holding
-- `tickets.assign`; a trigger that manufactures tickets from a meter reading is
-- a scheduler, and this build does not have one yet. The register will TELL you
-- a machine is 40 hours from service; a person still raises the job. 0161/0162's
-- lesson about controls nobody asked for cuts the same way for automation
-- nobody asked for.

-- ── The three numbers a usage strategy needs ──────────────────────────────
alter table assets add column if not exists service_interval_hours numeric(10,1)
  check (service_interval_hours is null or service_interval_hours > 0);

alter table assets add column if not exists running_hours numeric(10,1)
  check (running_hours is null or running_hours >= 0);

-- Not derivable from `last_serviced_at`. The meter reading AT the last service
-- is what the next one counts from, and a machine serviced on 3 February tells
-- you nothing about what its meter said that day.
alter table assets add column if not exists last_service_running_hours numeric(10,1)
  check (last_service_running_hours is null or last_service_running_hours >= 0);

-- When the reading was taken. A meter read three months ago is not the current
-- hours, and showing it as though it were is how "20 hours to service" becomes
-- "you missed it in June".
alter table assets add column if not exists running_hours_at timestamptz;

comment on column assets.service_interval_hours is
  'Running hours between services on a usage strategy. Required when maintenance_strategy = usage, null otherwise (assets_usage_needs_interval).';
comment on column assets.running_hours is
  'The hour-meter reading as last recorded, by log_asset_running_hours. Monotonic: a meter that goes backwards has been replaced, and that is a deliberate act (p_meter_replaced), never an ordinary edit.';
comment on column assets.last_service_running_hours is
  'What the meter read when the asset was last serviced — the point the next interval counts from. Not derivable from last_serviced_at, which records a DATE and says nothing about hours run.';
comment on column assets.running_hours_at is
  'When running_hours was read. A stale reading must not be presented as the current one.';

-- Mirrors `assets_calendar_needs_interval` (0121) exactly. A strategy that names
-- how servicing is triggered but not when is a strategy that triggers nothing.
alter table assets drop constraint if exists assets_usage_needs_interval;
alter table assets add constraint assets_usage_needs_interval
  check (maintenance_strategy <> 'usage' or service_interval_hours is not null);

-- ── Hours remaining, computed once ────────────────────────────────────────
--
-- A function rather than a column, because it is derived from three values that
-- each change on their own schedule, and a stored copy would be stale the
-- moment any of them moved. `last_service_running_hours` falls back to 0 for a
-- machine that has never been serviced — its whole life is the first interval,
-- which is correct.
create or replace function asset_hours_to_service(p_asset_id uuid)
returns numeric language sql stable set search_path = public as $$
  select case
           when a.maintenance_strategy <> 'usage' then null
           when a.service_interval_hours is null  then null
           when a.running_hours is null           then null
           else a.service_interval_hours
                - (a.running_hours - coalesce(a.last_service_running_hours, 0))
         end
    from assets a
   where a.id = p_asset_id;
$$;

comment on function asset_hours_to_service is
  'Running hours until the next service is due. Negative means overdue by that many hours — deliberately not clamped at zero, because "overdue by 300 hours" and "due now" are very different conversations with a landlord. Null when the asset is not on a usage strategy or has never been read.';

-- ── Recording a reading ───────────────────────────────────────────────────
--
-- A function rather than a column update through the ordinary asset form,
-- because a meter reading has a rule the form cannot express: it only ever goes
-- UP. A typo of 12000 for 1200 on a 1500-hour interval silently marks the
-- machine 10,500 hours overdue and it never gets serviced again.
create or replace function log_asset_running_hours(
  p_asset_id        uuid,
  p_hours           numeric,
  p_serviced        boolean default false,
  p_meter_replaced  boolean default false,
  p_note            text default null
)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  a assets%rowtype;
  v_org uuid := current_user_org_id();
  v_prev numeric;
begin
  if v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;

  -- The same capability that governs editing an asset. This function is
  -- DEFINER and therefore bypasses assets_write; a definer function that skips
  -- the check its own policy would have made is how a capability quietly stops
  -- meaning anything (0119).
  if not has_permission('assets.write') then
    raise exception 'you do not have permission to update an asset';
  end if;

  select * into a from assets where id = p_asset_id and deleted_at is null;
  if a.id is null or a.org_id is distinct from v_org then
    raise exception 'that asset is not in this organisation';
  end if;

  -- Place scoping, through the one resolver (decision 8). An FM/PM reads a
  -- meter on a machine at a property they hold, and nowhere else.
  if not has_permission('assets.read')
     and a.property_id not in (select current_user_property_ids()) then
    raise exception 'that asset is not on a property you manage';
  end if;

  if p_hours is null or p_hours < 0 then
    raise exception 'a meter reading cannot be negative';
  end if;

  v_prev := a.running_hours;

  -- ⚠️ The rule the form could not enforce. A reading below the last one means
  -- either a typo or a replaced meter, and those need different handling —
  -- so the caller has to say which, rather than the system guessing.
  if v_prev is not null and p_hours < v_prev and not p_meter_replaced then
    raise exception
      'that reading (%) is below the last one (%) — an hour meter only counts up. If the meter was replaced, say so explicitly.',
      trim(to_char(p_hours, 'FM999,999,990.0')),
      trim(to_char(v_prev,  'FM999,999,990.0'));
  end if;

  update assets
     set running_hours    = p_hours,
         running_hours_at = now(),
         -- A replaced meter restarts the count, so the service baseline has to
         -- move with it. Leaving it at the old figure would make the new meter
         -- read as instantly overdue by the whole of the old machine's life.
         last_service_running_hours = case
           when p_serviced       then p_hours
           when p_meter_replaced then 0
           else last_service_running_hours
         end,
         last_serviced_at = case when p_serviced then current_date
                                 else last_serviced_at end,
         updated_at = now()
   where id = p_asset_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (v_org, auth.uid(), 'asset.meter_read', 'asset', p_asset_id,
          jsonb_build_object('running_hours', v_prev,
                             'last_service_running_hours', a.last_service_running_hours),
          jsonb_build_object('running_hours', p_hours,
                             'serviced', p_serviced,
                             'meter_replaced', p_meter_replaced,
                             'note', nullif(trim(coalesce(p_note, '')), '')));

  return asset_hours_to_service(p_asset_id);
end;
$$;

revoke all on function log_asset_running_hours(uuid, numeric, boolean, boolean, text)
  from public, anon;
grant execute on function log_asset_running_hours(uuid, numeric, boolean, boolean, text)
  to authenticated;

comment on function log_asset_running_hours is
  'Records an hour-meter reading, optionally marking the asset serviced at that reading. Refuses a reading below the previous one unless the meter is declared replaced — the typo that would otherwise mark a generator permanently overdue. Returns the hours remaining until the next service. Audited, because when a machine was read and by whom is the evidence behind every usage-based service claim.';

-- ── The register's own view of what is due ────────────────────────────────
--
-- security_invoker, so RLS decides which assets the caller may count. A
-- maintenance report that answers the same for everyone is a leak dressed as a
-- report (0128's reasoning, same shape).
create or replace view asset_service_due
with (security_invoker = true) as
  select
    a.id, a.org_id, a.property_id, a.asset_tag, a.name, a.category,
    a.maintenance_strategy,
    a.next_service_due,
    a.service_interval_hours,
    a.running_hours,
    a.running_hours_at,
    a.last_service_running_hours,
    case when a.maintenance_strategy = 'usage'
              and a.service_interval_hours is not null
              and a.running_hours is not null
         then a.service_interval_hours
              - (a.running_hours - coalesce(a.last_service_running_hours, 0))
    end as hours_to_service,
    -- One column a list can sort and filter on, whichever strategy the asset is
    -- on. A register that can only rank calendar assets is half a register.
    case
      when a.maintenance_strategy = 'usage'
           and a.service_interval_hours is not null
           and a.running_hours is not null
        then (a.service_interval_hours
              - (a.running_hours - coalesce(a.last_service_running_hours, 0))) <= 0
      when a.maintenance_strategy = 'calendar' and a.next_service_due is not null
        then a.next_service_due <= current_date
      else false
    end as is_overdue
  from assets a
 where a.deleted_at is null;

comment on view asset_service_due is
  'What each asset needs next, in whichever unit its maintenance strategy is measured in — a date for calendar assets, running hours for usage ones — plus one is_overdue flag a list can sort on regardless. security_invoker so RLS still decides what the caller sees.';

revoke all on asset_service_due from anon, authenticated;
grant select on asset_service_due to authenticated;
