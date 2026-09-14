-- The service-charge client gets an organisation, and "associated to both brands"
-- gets somewhere to live.
--
-- Step 2 of the build workflow has promised this pattern since Day 1: a new client
-- may onboard "either as an independent isolated org, or nested under a brand, or
-- as an isolated org *associated* to one or both delivery brands (recommended)".
-- The schema only ever implemented two of those three.
--
-- ⚠️ **`orgs.delivery_brand` is single-valued and cannot say "both".** It is one
-- enum column ('TFML' | 'OEA' | 'direct'), and 0085 already learned the hard way
-- that it is not an identity — two OEA orgs collided when a slug was keyed on it.
-- `parent_org_id` is likewise a single nullable FK, so nesting expresses "belongs
-- to one brand" and nothing else. Neither column can record the arrangement the
-- board actually described for this client:
--
--     TFML  — service charge MANAGEMENT
--     OEA   — service charge ADMINISTRATION
--
-- Two brands, one client, neither owning it. That is the recommended pattern in
-- the workflow text and it was the one shape the tables could not hold, which is
-- why the SC client — the entity that triggered this entire brief — still had no
-- organisation, no front door and no logins.
--
-- ── What "associated" does NOT mean ───────────────────────────────────────
--
-- **Association is a statement about who does the work. It is not a grant of
-- access, and nothing in this migration lets one org read another's rows.**
--
-- This has to be said in the schema rather than in a design note, because the
-- obvious next step — "TFML delivers for this client, so let TFML staff see the
-- client's tickets" — is precisely the cross-org policy that B1 forbids and that
-- decision 7 deliberately routes through ONE audited definer function instead.
-- The single crossing of org isolation is the operator portal. A second one
-- introduced quietly through an association table would not look like a breach
-- while it was being written; it would look like a convenience.
--
-- So: no policy anywhere reads `org_brand_associations` to widen visibility, and
-- reading the table is scoped to your OWN org. A TFML user cannot query it to
-- discover which clients TFML serves, because that is the client list, and the
-- client list is operator-only (decision 12).

-- ── The association ───────────────────────────────────────────────────────
create table org_brand_associations (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  brand      delivery_brand not null,

  -- Free text under a check rather than an enum, deliberately. What a brand
  -- delivers for a client is a commercial description that grows with the
  -- business — 0092c exists because an enum had to be surgically corrected once
  -- rows already depended on it, and engagement names will move more often than
  -- collection statuses did.
  engagement text not null,

  created_at timestamptz not null default now(),

  -- 'direct' means "no brand delivers this"; it is the absence of a brand, so it
  -- can never be one half of an association.
  constraint org_brand_associations_needs_a_real_brand
    check (brand <> 'direct'),

  constraint org_brand_associations_engagement_not_blank
    check (length(trim(engagement)) > 0),

  -- A brand may hold more than one engagement for the same client, so the key
  -- includes the engagement. What must not happen is the same engagement recorded
  -- twice for the same brand and client.
  constraint org_brand_associations_uniq
    unique (org_id, brand, engagement)
);

create index org_brand_associations_org_idx on org_brand_associations(org_id);

comment on table org_brand_associations is
  'Which delivery brands serve an organisation, and in what capacity — the "associated to one or both brands" onboarding pattern from Step 2, which orgs.delivery_brand (single-valued) and orgs.parent_org_id (single FK) cannot express. Descriptive only: this table is never read by an RLS policy to widen access, because cross-org visibility has exactly one sanctioned route (the operator portal, decision 7).';

comment on column org_brand_associations.engagement is
  'What this brand does for this client, in the language of the engagement — e.g. "service charge management", "service charge administration".';

alter table org_brand_associations enable row level security;

-- You may see who serves YOUR organisation. You may not enumerate who a brand
-- serves — that is the client list, and it belongs to the operator (decision 12).
-- The operator branch gates inside the predicate rather than refusing, so a brand
-- administrator receives an empty set instead of an error; a refusal confirms
-- there is something worth refusing.
create policy org_brand_associations_read_own on org_brand_associations
  for select using (
    org_id = current_user_org_id() or caller_is_operator_admin()
  );

-- Writes are provisioning, not preference. Who delivers a client's service is
-- agreed commercially and recorded by the operator, the same authority that
-- creates and retires organisations (0079). An org administrator cannot promote
-- their own org into a brand's client book.
create policy org_brand_associations_operator_writes on org_brand_associations
  for all using (caller_is_operator_admin())
  with check (caller_is_operator_admin());

grant select on org_brand_associations to authenticated;
grant all    on org_brand_associations to service_role;

-- ── The service-charge client ─────────────────────────────────────────────
--
-- ⚠️ **The name below is a placeholder.** B5 calls this org "the entity that
-- triggered this brief" and never names it; no document in the repo carries the
-- real client name. It is recorded here as a plain description of what the org
-- is, so that nothing invented reads as fact.
--
-- Renaming it later is a two-line change AND A DELIBERATE ONE: `slug` is the
-- org's public address and 0085 made the backfill a one-off rather than a trigger
-- precisely so that renaming an org cannot silently break links already issued.
-- Change the name and you must decide, separately, whether the address moves.
--
-- `delivery_brand = 'direct'`: no single brand delivers this client, which is the
-- whole point of the association rows below. `parent_org_id` stays NULL — fully
-- independent, nested under neither brand.
insert into orgs (name, delivery_brand, slug, portal_name, tagline,
                  theme_primary, theme_logo_text, login_headline)
  select 'Service Charge Client', 'direct', 'sc-client',
         'Service Charge Portal',
         'Service charge administration and vendor payments.',
         '#1A1A2E', 'SC',
         'Sign in to your service charge portal.'
   where not exists (
     select 1 from orgs where lower(slug) = 'sc-client' and deleted_at is null
   );

do $$
declare
  v_org uuid;
begin
  select id into v_org
    from orgs where lower(slug) = 'sc-client' and deleted_at is null;

  if v_org is null then
    raise exception 'the service-charge client organisation was not created';
  end if;

  -- The arrangement, as described at the board: both brands, different capacities.
  insert into org_brand_associations (org_id, brand, engagement) values
    (v_org, 'TFML', 'service charge management'),
    (v_org, 'OEA',  'service charge administration')
  on conflict (org_id, brand, engagement) do nothing;

  -- A new org starts from the B7 baseline like any other — decision 7: defaults
  -- are the most restrictive workable state, opened deliberately afterwards.
  perform seed_b7_permissions(v_org);

  -- Lettings off: this client is service charge and vendor remittance, not
  -- tenancies. Document checks off, as decision 10 requires of every org.
  insert into org_modules (org_id, module, enabled)
  values (v_org, 'lettings', false), (v_org, 'ai_document_checks', false)
  on conflict (org_id, module) do nothing;
end $$;

-- ── Guard the thing this migration is most likely to lose ─────────────────
--
-- The association table's whole safety property is that it describes and never
-- grants. That property is invisible at the call site: a future policy could join
-- to it and read exactly like every other scoping clause, while quietly becoming
-- the second crossing of org isolation.
--
-- An org may not be associated to itself, and the two brands may not be recorded
-- as clients of each other — both are how "association" starts drifting from a
-- delivery fact into a hierarchy.
create or replace function org_brand_association_is_not_a_hierarchy()
returns trigger language plpgsql set search_path = public as $$
declare
  v_brand delivery_brand;
  v_operator boolean;
begin
  select delivery_brand, is_platform_operator
    into v_brand, v_operator
    from orgs where id = new.org_id;

  if v_operator then
    raise exception
      'the platform operator holds no client data — it cannot be a brand''s client';
  end if;

  -- Associations belong to the ISOLATED onboarding pattern: an org no single
  -- brand owns, hence `delivery_brand = 'direct'`. An org already carrying a
  -- brand is nested, and nesting is what `parent_org_id` is for. Allowing both
  -- at once would give two contradictory answers to "who owns this client".
  if v_brand <> 'direct' then
    raise exception
      'org is delivered by % — brand associations describe independent clients, and nesting belongs in parent_org_id', v_brand;
  end if;

  return new;
end;
$$;

create trigger org_brand_associations_not_a_hierarchy
  before insert or update on org_brand_associations
  for each row execute function org_brand_association_is_not_a_hierarchy();

comment on function org_brand_association_is_not_a_hierarchy is
  'Association records who delivers a client''s service. It is not ownership and not nesting — parent_org_id is where nesting lives. Enforced because a self- or brand-to-brand association is the first shape the table takes on when it starts being used as a hierarchy.';
