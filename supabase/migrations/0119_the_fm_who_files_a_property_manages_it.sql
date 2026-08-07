-- An FM/PM could not add a property — the first step of their own journey.
--
-- "See and manage his properties" is step one of the documented FM/PM
-- journey, and creating one failed in every organisation with:
--
--     new row violates row-level security policy for table "properties"
--
-- ⚠️ The INSERT was never the problem, which is why this took isolating rather
-- than reading. Evaluated as the FM, both halves of `properties_insert` are
-- true — they hold `properties.write`, and the org matches. An insert with no
-- `RETURNING` succeeds. It is the `RETURNING id` that is refused, because
-- **Postgres applies SELECT policies to a RETURNING clause**, and
-- `properties_select` admits a row only via `properties.read_all` (which an
-- FM does not hold, by design — B7 scopes them to assigned properties) or
-- `id IN current_user_property_ids()`.
--
-- A property that was created one microsecond ago has no stakeholder rows. So
-- it is not in their scope, so they cannot read it back, so the statement they
-- used to create it fails. The app does exactly this
-- (`.insert(row).select("id").single()`), so an FM pressing "Create property"
-- got a flat RLS error.
--
-- 📌 The fix is not to widen `properties_select`, and not to drop the
-- `RETURNING`. It is that **the person who files a property manages it** —
-- which is both the honest answer to "why can't they see it" and exactly what
-- B7 already means by "assigned properties". Attaching the creator is the
-- missing half of the create, not a workaround for it.
create or replace function create_property(
  p_name text,
  p_address text default null,
  p_reference text default null,
  p_site_node_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := current_user_org_id();
  v_id  uuid;
begin
  if v_org is null then
    raise exception 'you are not signed in to an organisation';
  end if;
  -- The same capability `properties_insert` gates on. Checked here because
  -- this function is DEFINER and therefore bypasses that policy: a definer
  -- function that skips the check its own policy would have made is how a
  -- capability quietly stops meaning anything.
  if not has_permission('properties.write') then
    raise exception 'you do not have permission to add a property';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'give the property a name';
  end if;

  insert into properties (org_id, name, address, reference, site_node_id)
  values (v_org, trim(p_name), nullif(trim(coalesce(p_address, '')), ''),
          nullif(trim(coalesce(p_reference, '')), ''), p_site_node_id)
  returning id into v_id;

  -- ⚠️ The half that was missing. Without it the creator cannot read back what
  -- they just made — and an admin, who holds `properties.read_all`, would
  -- never have noticed, because their read does not depend on this row.
  -- Skipped for a service-role caller (seeding, imports), which has no
  -- `auth.uid()` to attach.
  if auth.uid() is not null then
    insert into property_stakeholders (org_id, property_id, user_id, relation)
    values (v_org, v_id, auth.uid(), 'manager')
    on conflict (property_id, user_id, relation) do nothing;
  end if;

  return v_id;
end;
$$;

revoke all on function create_property(text, text, text, uuid) from public, anon, authenticated;
grant execute on function create_property(text, text, text, uuid) to authenticated;

comment on function create_property is
  'Adds a property and attaches the creator as its manager. The attachment is not a convenience: an FM/PM holds no properties.read_all (B7 scopes them to assigned properties), so without it they cannot read back the row they just created -- and since Postgres applies SELECT policies to RETURNING, the create statement itself failed.';
