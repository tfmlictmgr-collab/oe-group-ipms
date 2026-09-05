-- A property is created with at least one unit, in one transaction
-- (decision 31, 5 Sept 2026).
--
-- Reported as: "inclusion of units when adding property should be compulsory."
-- Two separate defects sit underneath that sentence.
--
--   1. Units were optional and labelled so. `PropertyForm` prints
--      "Units (optional)", and the submit guard is `name.trim().length >= 2` and
--      nothing else. A property with no units cannot be let, cannot be billed a
--      service charge, and — after 0225 — cannot have a tenancy recorded
--      against it at all, so it is a building the product can file and then do
--      nothing with.
--
--   2. ⚠️ Worse, and not reported because it is invisible: the two writes were
--      never atomic. `saveProperty` creates the property through
--      `create_property` (0119), then `saveUnit` creates the units in a SECOND
--      round trip, and the failure branch says so in its own copy: "Property
--      added, but its units were not." So the state this decision forbids was
--      not merely allowed, it was PRODUCED by any failure of the second call —
--      and the person saw a partial success message and moved on.
--
-- This adds the one door that cannot leave that state behind. A function body
-- is a single transaction, so a unit that will not insert takes the property
-- back out with it.
--
-- 📌 NOT a table constraint. Measured live: 2 of 17 properties currently have
-- no units. A blanket check would refuse to apply, and forcing a repair as a
-- side effect of a migration about creation would be inventing unit data for
-- two real buildings to satisfy a rule about new ones. They are grandfathered,
-- and reachable instead: decision 31's other half lets a unit be added inline
-- from the tenancy form, which is precisely where someone meets one of these
-- two properties and needs it fixed.

create or replace function create_property_with_units(
  p_name text,
  p_address text default null,
  p_reference text default null,
  p_site_node_id uuid default null,
  p_property_type text default null,
  p_units jsonb default '[]'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  v_id uuid;
  v_made integer;
begin
  if jsonb_typeof(p_units) is distinct from 'array' or jsonb_array_length(p_units) = 0 then
    raise exception 'a property is filed with at least one unit — add the flats, shops or suites it contains';
  end if;

  -- Authority, org and name are all checked inside create_property, which is
  -- the function `properties_insert` mirrors. Reused rather than reimplemented:
  -- a second insert path would be a second place for the capability check to
  -- drift out of, which is the fault 0119's own header describes.
  v_id := create_property(p_name, p_address, p_reference, p_site_node_id);

  -- 📌 The create path has been silently dropping the property type since 0237
  -- added it: `saveProperty` builds `property_type` into its row object and
  -- then calls `create_property`, which takes four arguments and none of them
  -- is that one. Only the UPDATE path ever wrote it, so every property filed
  -- since 0237 has been typed only if somebody went back and edited it.
  if nullif(trim(coalesce(p_property_type, '')), '') is not null then
    update properties
       set property_type = trim(p_property_type)
     where id = v_id;
  end if;

  v_made := create_units(v_id, p_units);
  if coalesce(v_made, 0) < 1 then
    raise exception 'no units were created for this property';
  end if;

  return v_id;
end;
$fn$;

comment on function create_property_with_units(text, text, text, uuid, text, jsonb) is
  'Files a property and its units in one transaction; refuses a property with no units (0252).';

revoke all on function create_property_with_units(text, text, text, uuid, text, jsonb) from public, anon;
grant execute on function create_property_with_units(text, text, text, uuid, text, jsonb) to authenticated, service_role;

do $$
declare v_bad text;
begin
  select string_agg(distinct routine_name || ' → ' || grantee, ', ')
    into v_bad
    from information_schema.routine_privileges
   where specific_schema = 'public'
     and grantee in ('anon', 'PUBLIC')
     and routine_name = 'create_property_with_units';
  if v_bad is not null then
    raise exception 'these functions are callable by anon or PUBLIC and must not be: %', v_bad;
  end if;
end $$;
