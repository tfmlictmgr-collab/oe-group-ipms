-- Aggregate the portfolio in the database, not in the page.
--
-- The properties list fetched EVERY unit in the org and counted them in
-- JavaScript. PostgREST caps a response at 1000 rows by default, so at the
-- 100+ properties this system is specified for (scope decision 1) the counts
-- would quietly go wrong — and wrong in the worst direction, silently
-- understating occupancy rather than failing.
--
-- `security_invoker` keeps the caller's RLS in force, so an FM/PM still sees
-- only the properties they are attached to and this widens nothing.

create or replace view property_summary
with (security_invoker = on) as
  select
    p.id,
    p.org_id,
    p.name,
    p.reference,
    p.address,
    p.property_type,
    count(u.id)                                        as unit_count,
    count(u.occupant_user_id)                          as occupied_count,
    coalesce(sum(u.apportionment_factor), 0)           as total_factor,
    count(a.id)                                        as asset_count
  from properties p
  left join units u
    on u.property_id = p.id and u.deleted_at is null
  left join assets a
    on a.property_id = p.id and a.deleted_at is null
  where p.deleted_at is null
  group by p.id, p.org_id, p.name, p.reference, p.address, p.property_type;

comment on view property_summary is
  'Per-property counts for the portfolio list. security_invoker, so the caller''s RLS on properties/units/assets still decides what is included.';

grant select on property_summary to authenticated;
