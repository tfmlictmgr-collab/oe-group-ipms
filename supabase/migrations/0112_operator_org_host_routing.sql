-- The operator org's own custom domain must reach the real /login door, not the
-- generic per-org sign-in template.
--
-- `app/page.tsx` redirects a resolved host straight to `/o/<slug>` for ANY org,
-- because that is correct for every client org (TFML, OEA, an SC client) — but
-- it is wrong for the platform operator (`oe-group`). `/login` is deliberately
-- anonymous and names no organisation (B1: "reveals nothing about who is on the
-- platform"); `/o/<slug>` is built for a client org's own front door and locks
-- sign-in to that org's `expectedOrgId`. Routing the operator's domain through
-- `/o/oe-group` would silently trade the anonymous door for the client-facing
-- one, so the root page needs to tell the two apart.
--
-- `org_branding_by_host` already returns everything root needs to paint a host's
-- branding; it just never told the caller whether the resolved org IS the
-- platform operator. Adding that one column is the whole fix — no new function,
-- no new table, and nothing about how a hostname is bound or resolved changes.
--
-- Postgres refuses `create or replace` when a table-returning function's row
-- shape changes ("cannot change return type of existing function") — an added
-- OUT column counts as a shape change even though every existing column is
-- untouched, so the function must be dropped first. The two grants below
-- recreate exactly what `0089` already granted; nothing about who may call this
-- changes.
drop function if exists org_branding_by_host(text);

create function org_branding_by_host(p_host text)
returns table (
  id uuid,
  slug text,
  name text,
  portal_name text,
  tagline text,
  login_headline text,
  logo_url text,
  theme_primary text,
  theme_accent text,
  theme_logo_text text,
  delivery_brand delivery_brand,
  is_platform_operator boolean
)
language sql stable security definer set search_path = public as $$
  select o.id, o.slug, o.name, o.portal_name, o.tagline, o.login_headline,
         o.logo_url, o.theme_primary, o.theme_accent, o.theme_logo_text,
         o.delivery_brand, o.is_platform_operator
    from orgs o
   where lower(o.custom_domain) = lower(split_part(trim(p_host), ':', 1))
     and o.custom_domain is not null
     and o.deleted_at is null
   limit 1;
$$;

revoke all on function org_branding_by_host(text) from public;
grant execute on function org_branding_by_host(text) to anon, authenticated, service_role;

comment on function org_branding_by_host is
  'The organisation answering on a hostname, for painting its front door. At most one row and cannot list, exactly as org_public_branding. Branding only — never used to decide what data a caller may reach. Carries is_platform_operator so root routing can send the operator''s own domain to /login instead of /o/<slug> (0112).';
