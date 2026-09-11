-- Decision 8, the clause that was never built.
--
-- > **Assets state their scope.** `assets.scope` ∈ `unit | property | site`.
-- > "Shared" is a stated fact, never an absent `unit_id` — a nullable FK used
-- > as a meaning produced three live defects in one week, because NULL never
-- > matches an `IN` list.
--
-- The hierarchy half of that decision shipped (0121 added assemblies, mobility
-- and maintenance strategy; `org_nodes` and the extended
-- `current_user_property_ids()` came earlier). This column did not, so today
-- the register still expresses "shared" the exact way the board forbade: by
-- leaving `unit_id` null and hoping the reader infers it.
--
-- ⚠️ Why that is not merely untidy. `unit_id is null` today means at least three
-- different things: a lift serving the whole building, a generator serving a
-- whole site, and *a unit-level asset somebody has not finished filing*. They
-- are indistinguishable, so no query can separate "shared plant" from
-- "incomplete data" — and the NULL-versus-IN trap the board cited is exactly
-- how a shared asset silently drops out of any per-unit report.

alter table assets add column if not exists scope text not null default 'property'
  check (scope in ('unit', 'property', 'site'));

-- Backfill from the only evidence there is, and no further.
--
-- An asset with a unit is unit-scoped; that is unambiguous. Everything else
-- becomes `property` — NOT `site`, because nothing in the existing data
-- distinguishes "serves this building" from "serves the whole site", and
-- guessing `site` would put an asset outside the property it is actually on.
-- `site` is therefore reachable only by someone stating it, which is what
-- decision 8 asks for.
update assets set scope = 'unit' where unit_id is not null and scope = 'property';

-- ── The scope and the FK must agree ───────────────────────────────────────
--
-- Without this the column is decoration: a row could claim `scope = 'unit'`
-- with no unit, or `scope = 'site'` while pinned to one. Either makes the
-- stated fact a lie, which is worse than the inference it replaced.
create or replace function assets_scope_matches_unit()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.scope = 'unit' and new.unit_id is null then
    raise exception 'a unit-scoped asset must name the unit it is in';
  end if;
  if new.scope in ('property', 'site') and new.unit_id is not null then
    raise exception 'a %-scoped asset serves more than one unit, so it cannot be pinned to one', new.scope;
  end if;
  return new;
end;
$$;

drop trigger if exists assets_scope_valid on assets;
create trigger assets_scope_valid
  before insert or update of scope, unit_id on assets
  for each row execute function assets_scope_matches_unit();

comment on column assets.scope is
  'What this asset serves: unit (pinned to one, unit_id required), property (shared across the building), or site (shared across the whole site). Decision 8 -- "shared" is a STATED fact, never an absent unit_id, because NULL never matches an IN list and a shared asset would silently drop out of every per-unit report. Backfilled from unit_id; `site` is reachable only by someone stating it, since nothing in the existing data distinguishes it from `property`.';

comment on function assets_scope_matches_unit is
  'Keeps assets.scope and assets.unit_id consistent. Without it the column is decoration -- a row could claim unit scope with no unit, or site scope while pinned to one, which makes the stated fact a lie and is worse than the inference it replaced.';

-- ── What a per-unit report should actually call ───────────────────────────
--
-- The reason the column exists: asking "what serves unit X" must return the
-- unit's own assets AND the shared ones above it, and an `IN (unit_id)` query
-- can never do that. Provided here so the answer is written once rather than
-- re-derived — correctly or otherwise — by each caller.
create or replace function assets_serving_unit(p_unit_id uuid)
returns setof assets
language sql stable security invoker set search_path = public as $$
  select a.*
    from assets a
    join units u on u.id = p_unit_id
   where a.org_id = u.org_id
     and (
       -- the unit's own
       (a.scope = 'unit' and a.unit_id = u.id)
       -- plus everything shared across the property it sits in
       or (a.scope in ('property', 'site') and a.property_id = u.property_id)
     )
     and a.deleted_at is null
   order by a.scope, a.name;
$$;

revoke all on function assets_serving_unit(uuid) from public;
revoke execute on function assets_serving_unit(uuid) from anon;
grant execute on function assets_serving_unit(uuid) to authenticated;

comment on function assets_serving_unit is
  'Every asset serving a unit: its own, plus the property- and site-scoped ones above it. SECURITY INVOKER, so the asset policy still decides what the caller may see. Exists because `unit_id IN (...)` structurally cannot answer this -- the shared plant a tenant actually depends on has no unit_id and would be missing from every such query.';
