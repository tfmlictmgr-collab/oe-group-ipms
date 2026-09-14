-- A contractor can find the building, for as long as the job is live
-- (7 Sept 2026).
--
-- Measured before writing, as a signed-in vendor on staging:
--
--     vendor tickets                4
--       84b5ce66  property 67d44656  status=assigned
--     vendor reads those properties  0
--     embed tickets→properties       properties: null
--
-- A contractor is dispatched to a building and the product will not tell them
-- WHICH BUILDING, or its address. They are handed a reference and a sentence of
-- description. Every screen that tried to name the place rendered nothing,
-- because `properties_select` has never had a branch for them — the register
-- admits `properties.read_all` (staff) or `current_user_property_ids()`
-- (stakeholders), and a vendor is neither. Exactly the shape `0226` found for
-- the tenant, one role over: not a regression, just never built, and invisible
-- because until somebody looked at a job card as the vendor nobody noticed the
-- address was blank.
--
-- ── The reach is the JOB, and it lapses ───────────────────────────────────
--
-- Asked for as: see the property while the job is live, lose it after the work
-- is signed off and paid, keep the job history for audit. All three are
-- separate facts and only the middle one is new:
--
--   • **Live** — `caller_is_vendor_on_live_job()` below. Any ticket on that
--     property assigned to one of the caller's vendor companies that is either
--     not yet signed off, OR still has money in flight against it.
--   • **Lapsed** — the same predicate returning false. Nothing is revoked and
--     no job runs; the answer simply changes when the last ticket closes and
--     its last payment settles. A scheduled sweep would be a second source of
--     truth for a fact the tickets already hold — the same reason `0263` refuses
--     to store a `lapsed` offer status and computes it instead.
--   • **History** — untouched. `tickets_select` has always returned a vendor
--     their own assigned jobs, forever, and this migration does not narrow it.
--     Losing the BUILDING does not lose the JOB: the record of what they did,
--     when, and what they were paid stays exactly where it was. That is the
--     distinction the request draws and it is worth stating, because "lose
--     access after payment" read carelessly would delete a contractor's own
--     work history out from under an audit.
--
-- ⚠️ `current_user_property_ids()` IS NOT TOUCHED, for the third time in this
-- schema and the same reason each time (`0184`, `0226`). It is referenced by 42
-- policy clauses and does not filter on relation; teaching it about jobs would
-- hand every contractor whatever those 42 clauses grant — the asset register,
-- the unit register, service charges, tenancies. The branch goes in the two
-- policies that need it and states which case it is for.
--
-- 📌 And it is a NARROW resolver, not a second general one. Decision 8 forbids
-- a second scoping mechanism beside the first; this is the pattern
-- `current_user_vendor_ids()` (decision 17) and `current_user_payable_ticket_ids()`
-- (decision 19) already set — a named predicate for one audience, used by the
-- policies that name it.

create or replace function caller_is_vendor_on_live_job(p_property_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tickets t
     where t.property_id = p_property_id
       and t.org_id = current_user_org_id()
       and t.assigned_vendor_id in (select current_user_vendor_ids())
       and (
         -- Not signed off yet.
         t.status not in ('resolved', 'closed')
         -- Or signed off, and money for it has not settled. A rejected invoice
         -- settles it too: there is nothing further to attend for.
         or exists (
           select 1 from payments p
            where p.ticket_id = t.id
              and p.status not in ('remitted', 'rejected')
         )
       )
  );
$$;

comment on function caller_is_vendor_on_live_job is
  'Whether the caller''s vendor company holds a LIVE job on this property — assigned to them and either not signed off, or signed off with a payment still in flight. The vendor twin of caller_is_tenant_of_place (0226), and deliberately NOT part of current_user_property_ids(): that resolver is read by 42 policy clauses and a contractor has no business in any of the others (0269).';

revoke all on function caller_is_vendor_on_live_job(uuid) from public, anon;
grant execute on function caller_is_vendor_on_live_job(uuid) to authenticated, service_role;

-- ── A service request can name the flat it is about ───────────────────────
--
-- ⚠️ Found while measuring the above: `tickets.unit_id` DOES NOT EXIST.
--
--     column tickets.unit_id does not exist
--     Could not find a relationship between 'tickets' and 'units'
--
-- So "which apartment is this about" has never been answerable — not to the
-- contractor being sent, not to the manager triaging, not to the tenant who
-- reported it. A ticket names a building of forty flats and a sentence. And any
-- screen that tried to embed the unit got a 500 for every role, which is how
-- this stayed invisible: the query that would have shown the gap was itself
-- broken.
--
-- The composite form, referencing `units (id, org_id)`, for the same reason
-- `0225` used it on `leases`: an id alone would let a ticket point at a unit in
-- another organisation, which is B1 reached through a nullable FK. Nullable,
-- because most requests genuinely are about the building — a generator, a gate,
-- a car park — and forcing a unit would invent one.
alter table tickets add column if not exists unit_id uuid;
alter table tickets add column if not exists unit_org_id uuid
  generated always as (org_id) stored;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tickets_unit_same_org_fk'
  ) then
    alter table tickets
      add constraint tickets_unit_same_org_fk
      foreign key (unit_id, unit_org_id) references units (id, org_id);
  end if;
end $$;

create index if not exists tickets_unit_idx on tickets(unit_id) where unit_id is not null;

comment on column tickets.unit_id is
  'The flat, shop or office this request is about, where it is about one. Nullable: a generator, a gate or a car park belongs to the building and inventing a unit for it would be worse than leaving this empty. Added by 0269 — until then a request named a building of forty flats and nothing narrower, and PostgREST could not embed the unit at all because no relationship existed.';

-- ── The two consumers, each stating its own audience ──────────────────────
--
-- Rewritten from the LIVE policy expression (0136/0183), with one disjunct
-- added to each and nothing else moved.
drop policy if exists properties_select on properties;
create policy properties_select on properties for select
  using (
    (deleted_at is null)
    and (org_id = current_user_org_id())
    and (
      (select has_permission('properties.read_all'::text))
      or (id in (select current_user_property_ids()))
      -- 0226. A tenant reads the building they rent, and no other.
      or caller_is_tenant_of_place(id, null)
      -- 0269. A contractor reads the building they are working in, while they
      -- are working in it.
      or caller_is_vendor_on_live_job(id)
    )
  );

drop policy if exists units_select on units;
create policy units_select on units for select
  using (
    (deleted_at is null)
    and (org_id = current_user_org_id())
    and (
      (occupant_user_id = auth.uid())
      or (select has_permission('properties.read_all'::text))
      or (select has_permission('sc.read_all'::text))
      or (property_id in (select current_user_property_ids()))
      or caller_is_tenant_of_place(property_id, id)
      -- 0269. The flat the job is in — the whole point of `tickets.unit_id`
      -- above is that somebody can be told which door to knock on.
      or caller_is_vendor_on_live_job(property_id)
    )
  );

comment on policy properties_select on properties is
  'Staff with properties.read_all, anyone the property resolves to through current_user_property_ids(), the tenant of a tenancy on it (0226), and a contractor holding a live job on it (0269). The last lapses on its own when the job is signed off and its money has settled — nothing is revoked, the predicate simply stops being true.';

comment on policy units_select on units is
  'The recorded occupant, staff with properties.read_all or sc.read_all, anyone the property resolves to, the tenant of a tenancy on the unit (0226), and a contractor on a live job at that property (0269).';

-- ── Prove the lapse is a rule and not a list ──────────────────────────────
--
-- A vendor must reach a property ONLY through this predicate. If anything else
-- ever admits them, the time bound above becomes decorative — the property
-- would stay readable through the other branch after the job closed, and
-- nothing would say so.
do $$
declare v_def text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid) into v_def
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
   where c.relname = 'properties' and pol.polname = 'properties_select';

  if v_def not like '%caller_is_vendor_on_live_job%' then
    raise exception 'properties_select lost the vendor branch';
  end if;
end $$;
