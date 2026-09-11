-- Each brand answers on its own hostname — B1's first isolation layer.
--
-- `portal.tfmlconsultant.com` resolves TFML, `portal.oraegbunike.com` resolves
-- OEA, and neither host can be made to serve the other's front door.
--
-- ⚠️ **A hostname is branding and routing. It is never authority.** The Host
-- header is supplied by the client; a proxy in front of us validates it, but the
-- application must not depend on that being true. So `custom_domain` decides
-- which sign-in screen is painted and nothing else — the caller's organisation
-- still comes from the verified JWT, and RLS still decides every row. Someone
-- who forges a Host header sees another brand's *colours* on a login form and
-- gains not one row of their data.
--
-- ⚠️ And it is **operator-set, deliberately not in the `0083c` column allowlist**
-- that lets a brand administrator edit their own branding. A tenant who could
-- write their own `custom_domain` could claim a hostname belonging to another
-- tenant and have the platform paint their brand on it. Claiming a domain is a
-- platform act, so it goes through an audited operator function.

alter table orgs add column if not exists custom_domain text;

-- Unique among live orgs, case-folded — hostnames are case-insensitive and two
-- orgs answering on one host is not a configuration, it is a collision.
create unique index if not exists orgs_custom_domain_uidx
  on orgs (lower(custom_domain)) where custom_domain is not null and deleted_at is null;

comment on column orgs.custom_domain is
  'The hostname this org answers on (e.g. portal.tfmlconsultant.com). Branding and routing only, never authority — the caller''s org comes from the JWT. Operator-set: see set_org_domain().';

-- ── Resolving a host to its organisation ──────────────────────────────────
--
-- Same shape and the same guarantees as `org_public_branding`: takes one host,
-- returns at most one row, cannot be made to list. An unknown host returns
-- nothing, which the application renders as the ordinary OE Group sign-in — so
-- probing hostnames maps nothing.
create or replace function org_branding_by_host(p_host text)
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
  delivery_brand delivery_brand
)
language sql stable security definer set search_path = public as $$
  select o.id, o.slug, o.name, o.portal_name, o.tagline, o.login_headline,
         o.logo_url, o.theme_primary, o.theme_accent, o.theme_logo_text,
         o.delivery_brand
    from orgs o
   -- Port stripped and case folded: "PORTAL.TFML.com:3000" and
   -- "portal.tfml.com" are the same host, and a mismatch here would silently
   -- fall through to the generic sign-in on a perfectly valid request.
   where lower(o.custom_domain) = lower(split_part(trim(p_host), ':', 1))
     and o.custom_domain is not null
     and o.deleted_at is null
   limit 1;
$$;

revoke all on function org_branding_by_host(text) from public;
grant execute on function org_branding_by_host(text) to anon, authenticated, service_role;

comment on function org_branding_by_host is
  'The organisation answering on a hostname, for painting its front door. At most one row and cannot list, exactly as org_public_branding. Branding only — never used to decide what data a caller may reach.';

-- ── Claiming a domain is an operator act, and it is audited ───────────────
alter table operator_actions drop constraint if exists operator_actions_action_check;
alter table operator_actions add constraint operator_actions_action_check
  check (action in ('provision_org', 'suspend_user', 'unsuspend_user', 'break_glass',
                    'retire_org', 'unretire_org', 'set_org_domain'));

create or replace function set_org_domain(
  p_org_id uuid,
  p_domain text,
  p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_org    orgs%rowtype;
  v_clean  text := nullif(lower(trim(coalesce(p_domain, ''))), '');
begin
  if v_caller is not null and not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may set an organisation''s domain';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  select * into v_org from orgs where id = p_org_id;
  if v_org.id is null then
    raise exception 'that organisation could not be found';
  end if;
  if v_org.deleted_at is not null then
    raise exception 'that organisation is retired';
  end if;

  -- A hostname, not a URL and not a path. Rejecting these here is the difference
  -- between a clear refusal and a domain that silently never matches, because
  -- `org_branding_by_host` compares against a bare host and always would.
  if v_clean is not null then
    if v_clean like '%/%' or v_clean like '%:%' or v_clean not like '%.%' then
      raise exception 'give a bare hostname such as portal.example.com — no scheme, port or path';
    end if;
    if exists (
      select 1 from orgs o
       where lower(o.custom_domain) = v_clean
         and o.id <> p_org_id and o.deleted_at is null
    ) then
      raise exception 'another organisation already answers on %', v_clean;
    end if;
  end if;

  update orgs set custom_domain = v_clean where id = p_org_id;

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, coalesce(current_user_org_id(), p_org_id), p_org_id, 'set_org_domain',
          trim(p_reason),
          jsonb_build_object('domain', v_clean, 'previous', v_org.custom_domain));
end;
$$;

revoke all on function set_org_domain(uuid, text, text) from public;
grant execute on function set_org_domain(uuid, text, text) to authenticated, service_role;

comment on function set_org_domain is
  'Binds a hostname to an organisation. Operator-only and audited: a tenant able to set its own domain could claim a hostname belonging to another tenant and have the platform paint their brand on it.';
