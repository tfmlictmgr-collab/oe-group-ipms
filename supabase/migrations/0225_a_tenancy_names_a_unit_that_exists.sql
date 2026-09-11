-- A tenancy names a unit, and until now nothing said the unit had to exist.
--
-- `leases.unit_id` was declared `uuid not null` and **referenced nothing**
-- (0090). Every other identifying column on that table is constrained —
-- `property_id` carries `leases_property_same_org_fk` against
-- `properties (id, org_id)`, `tenant_user_id` and `created_by` reference
-- `users`, `renewed_from_lease_id` references `leases` itself. The unit, which
-- is the thing a tenancy is actually ABOUT, was the one that was missed.
--
-- Two consequences, and the second is the one that bit:
--
--   1. **Integrity.** Nothing prevented a lease pointing at a unit id that does
--      not exist, or — worse under B1 — at a unit belonging to another
--      organisation. `leases_property_same_org_fk` exists precisely because the
--      same risk was recognised for the property; the composite form is used
--      here for the same reason, so the unit and the lease must agree on
--      `org_id` and not merely on `id`.
--
--   2. **PostgREST could not embed it.** No foreign key means no relationship
--      in the schema cache, so `select("... units(label)")` answers *"Could not
--      find a relationship between 'leases' and 'units'"* — a 500, for every
--      role, on any screen that tries. That is exactly how this was found:
--      `verify-tenancy-statement.mjs` ran the new tenancy page's own query as a
--      real logged-in FM, finance user and tenant, and all three failed
--      identically before a person ever clicked the link.
--
-- ⚠️ The page does NOT depend on this migration. It fetches the unit as a
-- separate query, because a route that renders only once a constraint has been
-- deployed everywhere is a route that breaks a world mid-rollout. The FK is
-- worth having on its own merits; it is not load-bearing for the screen.
--
-- Verified clean before writing: across the whole database, 0 leases point at a
-- missing unit, 0 point at a unit in a different org, and 0 point at a unit on a
-- different property. The constraints below therefore validate rather than fail,
-- and they are stated so that stays true.

-- The composite target `properties` already has and `units` did not. Required
-- before a composite foreign key can reference it.
alter table units
  add constraint units_id_org_uniq unique (id, org_id);

alter table leases
  add constraint leases_unit_same_org_fk
  foreign key (unit_id, org_id) references units (id, org_id);

comment on constraint leases_unit_same_org_fk on leases is
  'A tenancy''s unit must exist AND belong to the same organisation as the tenancy. The composite twin of leases_property_same_org_fk (0090), which was written for the property and missed the unit beside it. Also what gives PostgREST a relationship to embed: without it, selecting units(...) from leases is a 500.';

-- ── The rule a foreign key cannot state ───────────────────────────────────
--
-- A composite FK can say "same org". It cannot say "and the unit is on the
-- property this lease names" — that is a three-table agreement, so it is a
-- trigger.
--
-- 0 rows violate it today. Deliberately raises rather than corrects: a lease
-- whose unit sits on a different property is not a value to be fixed up, it is
-- two contradictory statements about where somebody lives, and the person
-- entering it is the one who knows which is right.
create or replace function assert_lease_unit_on_property()
returns trigger language plpgsql set search_path = public as $$
declare
  v_property uuid;
begin
  select u.property_id into v_property from units u where u.id = new.unit_id;
  if v_property is null then
    raise exception 'That unit does not exist.' using errcode = '23503';
  end if;
  if v_property <> new.property_id then
    raise exception
      'That unit is not on this property. A tenancy records one home; the unit and the property have to agree on which.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function assert_lease_unit_on_property() from public;

create trigger leases_unit_on_property
  before insert or update of unit_id, property_id on leases
  for each row execute function assert_lease_unit_on_property();

comment on function assert_lease_unit_on_property is
  'A tenancy''s unit must sit on the property the tenancy names. Three tables have to agree, which is more than a foreign key can express. Raises rather than corrects: a mismatch is two contradictory statements about where a person lives, and only the person entering it knows which is right.';
