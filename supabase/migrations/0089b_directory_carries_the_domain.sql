-- The launcher shows each organisation's hostname, so an operator can see and
-- bind it in the one place the whole platform is visible.
--
-- Dropped and recreated rather than replaced: a function's OUT parameters are
-- part of its signature, and `create or replace` cannot add one — the same
-- constraint `create or replace view` has, which cost a migration earlier in
-- this build.
drop function if exists operator_org_directory();

create function operator_org_directory()
returns table (
  id uuid,
  name text,
  portal_name text,
  slug text,
  custom_domain text,
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
    o.id, o.name, o.portal_name, o.slug, o.custom_domain, o.logo_url,
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
