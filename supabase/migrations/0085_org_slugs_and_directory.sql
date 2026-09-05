-- Per-org entry URLs, and an org directory that does not publish the client list.
--
-- The ask: the OE Group home screen should show every org as an icon, each one
-- opening that org's own sign-in, instead of a single anonymous login box.
--
-- ⚠️ Half of that ask conflicts with B1, which is not a style rule: *"a user on
-- one portal must never see the other brand's data OR EXISTENCE."* A public grid
-- of every org publishes the entire client list — both brands, the service-charge
-- client, and every landlord org onboarded later — to anyone who loads the page.
--
-- So the ask is split along the line where it stops being safe:
--
--   • **Every org gets its own URL** (`/o/<slug>`), with its own branding on its
--     own sign-in. Public, because a link you were given is not an enumeration —
--     `org_public_branding` resolves ONE slug and cannot list.
--   • **The grid of icons lives behind the operator sign-in.** An OE Group
--     operator signs in once and gets the launcher; `operator_org_directory()`
--     refuses everyone else. That is the same crossing decision 7 already routes
--     through one audited definer function, not a new one.
--
-- Making the grid public later is a one-line policy change. Un-publishing a
-- client list that has been indexed is not, which is why the default is this way
-- round and why it is stated here rather than assumed.

-- ── A stable, URL-safe name for each org ───────────────────────────────────
alter table orgs add column if not exists slug text;

-- Slugs are the org's public address, so they must be unique and stable. Case
-- folded because a URL is not case sensitive in practice and two orgs differing
-- only in case would be one address for two organisations.
--
-- Scoped to LIVE orgs. A retired organisation has no public address, and holding
-- its slug hostage forever would mean a name could never be reissued — the same
-- reason `properties_org_reference_uidx` excludes retired rows.
create unique index if not exists orgs_slug_uidx
  on orgs (lower(slug)) where slug is not null and deleted_at is null;

comment on column orgs.slug is
  'The org''s own public entry path (/o/<slug>). Unique among live orgs, case-folded. Nullable: an org with no slug simply has no friendly URL yet, which is a valid state.';

-- Backfill the live orgs only.
--
-- ⚠️ The first draft of this keyed the slug on `delivery_brand` — and there are
-- two OEA orgs (the live one and a retired test fixture), so both claimed 'oea'
-- and the index refused the whole migration. `delivery_brand` was never unique;
-- it says which brand delivers the work, not which organisation this is. The
-- name is the thing that identifies an org, so the name is what the slug derives
-- from, with the two brands named explicitly because their public URLs were
-- agreed before this table existed.
--
-- A one-off backfill and not a trigger, deliberately: a slug that silently
-- changed when someone renamed their org would break every link already issued.
update orgs
   set slug = trim(both '-' from case
     when delivery_brand = 'TFML' then 'tfml'
     when delivery_brand = 'OEA'  then 'oea'
     else regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g')
   end)
 where slug is null
   and deleted_at is null;

-- ── One org's public face, by slug. Never a list. ──────────────────────────
--
-- Definer because the caller is anonymous — there is no session to read with.
-- It returns exactly what a stranger holding the link may see: the name, the
-- logo and the colours. No counts, no contact details, no indication of what
-- else exists. Being unable to enumerate is the property that matters here, so
-- it takes a slug and returns at most one row, rather than taking a filter.
create or replace function org_public_branding(p_slug text)
returns table (
  id uuid,
  name text,
  portal_name text,
  tagline text,
  login_headline text,
  logo_url text,
  theme_primary text,
  theme_accent text,
  theme_logo_text text,
  delivery_brand delivery_brand
)
language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.portal_name, o.tagline, o.login_headline, o.logo_url,
         o.theme_primary, o.theme_accent, o.theme_logo_text, o.delivery_brand
    from orgs o
   where lower(o.slug) = lower(trim(p_slug))
     and o.deleted_at is null
   limit 1;
$$;

revoke all on function org_public_branding(text) from public;
grant execute on function org_public_branding(text) to anon, authenticated, service_role;

comment on function org_public_branding is
  'One organisation''s public face, resolved by slug for its own sign-in page. Takes a slug and returns at most one row — it cannot be made to list, which is what keeps B1''s "or existence" rule intact while still giving every org its own branded URL.';

-- ── The directory. Operators only. ─────────────────────────────────────────
--
-- `caller_is_operator_admin()` comes from 0083 and is the same gate org
-- retirement uses. An ordinary brand admin calling this gets nothing back —
-- not an error that confirms the function exists and matters, simply no rows,
-- because a refusal is itself information about what is on the other side.
create or replace function operator_org_directory()
returns table (
  id uuid,
  name text,
  portal_name text,
  slug text,
  logo_url text,
  theme_primary text,
  theme_logo_text text,
  delivery_brand delivery_brand,
  is_platform_operator boolean,
  retired boolean,
  member_count bigint,
  property_count bigint
)
language sql stable security definer set search_path = public as $$
  select
    o.id, o.name, o.portal_name, o.slug, o.logo_url,
    o.theme_primary, o.theme_logo_text, o.delivery_brand,
    o.is_platform_operator,
    o.deleted_at is not null as retired,
    (select count(*) from users u
      where u.org_id = o.id and u.deactivated_at is null)      as member_count,
    (select count(*) from properties p
      where p.org_id = o.id and p.deleted_at is null)          as property_count
  from orgs o
  where caller_is_operator_admin()
  order by o.deleted_at nulls first, o.name;
$$;

revoke all on function operator_org_directory() from public;
grant execute on function operator_org_directory() to authenticated, service_role;

comment on function operator_org_directory is
  'Every organisation on the platform, for the OE Group operator launcher. Gated on caller_is_operator_admin() INSIDE the query, so a non-operator receives an empty set rather than a refusal — a refusal would confirm there is something to be refused.';
