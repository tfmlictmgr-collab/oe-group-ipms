-- An org provisioned through the product had no working front door.
--
-- `operator_provision_org` (0097) is, by its own comment, "the function the
-- operator portal uses to onboard every future client" — it seeds the B7
-- permission baseline, the lettings flag, the geopolitical hierarchy and the
-- first admin's invitation. It never set `slug`. `orgs.slug` (0085) is what
-- `/login`'s redirect (`if hostOrg?.slug ... redirect('/o/${hostOrg.slug}')`)
-- needs to send someone to their own branded sign-in instead of the generic
-- one — and 0085's own backfill is explicit that it is a ONE-OFF, deliberately
-- not a trigger: "a slug that silently changed when someone renamed their org
-- would break every link already issued." A one-off does not reach an org
-- created afterwards. Every org this function provisions from here on would
-- have landed exactly where the service-charge client (0094) did before 0097's
-- catch-up found it: real, but with no address of its own, `hostOrg?.slug`
-- falsy, silently falling through to the generic OE Group login.
--
-- No application code path calls `operator_provision_org` yet either — this
-- migration is paired with the server action that finally does.
--
-- ⚠️ Unlike 0085's backfill, a collision here is not a one-time, hand-checked
-- event — it is the ordinary case the moment a second org shares a name, or a
-- second TFML/OEA-branded org is provisioned (the B1 "associated to a delivery
-- brand" pattern Step 2 describes). So this derives the same way 0085 did and
-- then walks numbered suffixes until `orgs_slug_uidx` is satisfied, the way a
-- username picker would, rather than assuming the first attempt succeeds.
create or replace function operator_provision_org(
  p_name           text,
  p_delivery_brand text,
  p_admin_email    text,
  p_admin_name     text,
  p_reason         text,
  p_token_hash     text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_caller    uuid := auth.uid();
  v_operator  uuid := current_user_org_id();
  v_org       uuid;
  v_base_slug text;
  v_slug      text;
  v_suffix    integer := 1;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may provision organisations';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'an organisation needs a name';
  end if;
  if coalesce(trim(p_admin_email), '') = '' then
    raise exception 'the first administrator needs an email address';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  v_base_slug := trim(both '-' from case
    when p_delivery_brand = 'TFML' then 'tfml'
    when p_delivery_brand = 'OEA'  then 'oea'
    else regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g')
  end);
  if v_base_slug = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (
    select 1 from orgs where lower(slug) = v_slug and deleted_at is null
  ) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  insert into orgs (name, delivery_brand, slug)
  values (trim(p_name), p_delivery_brand::delivery_brand, v_slug)
  returning id into v_org;

  perform seed_b7_permissions(v_org);

  insert into org_modules (org_id, module, enabled)
  values (v_org, 'lettings', p_delivery_brand = 'OEA')
  on conflict do nothing;

  perform seed_org_hierarchy(v_org);

  insert into invitations (org_id, email, role, full_name, token_hash, invited_by, expires_at)
  values (v_org, lower(trim(p_admin_email)), 'admin', nullif(trim(p_admin_name), ''),
          p_token_hash, v_caller, now() + interval '14 days');

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, coalesce(v_operator, v_org), v_org, 'provision_org', trim(p_reason),
          jsonb_build_object('name', trim(p_name), 'brand', p_delivery_brand,
                             'first_admin', lower(trim(p_admin_email)), 'slug', v_slug));

  return v_org;
end;
$$;

-- Callable in principle by anyone until now — refused only by the internal
-- `caller_is_operator_admin()` check, which is what verify-security-posture.mjs
-- calls "the one that looked worst" in the grant table. 0114 closed exactly
-- this gap on the sibling `provision_org`; this closes it here too, so the
-- function the operator portal actually calls does not rely on the internal
-- gate alone.
revoke all on function operator_provision_org(text, text, text, text, text, text) from public;
grant execute on function operator_provision_org(text, text, text, text, text, text) to authenticated, service_role;

comment on function operator_provision_org is
  'Provisions a new organisation: seeds the B7 permission baseline, the lettings flag from its brand, its geopolitical hierarchy and an admin invitation — and now a unique slug, derived the way 0085 backfilled one (TFML/OEA keep their pre-agreed addresses, everything else slugifies the name), with numbered suffixes on collision since unlike the backfill this runs on every future insert. Without it the org has no working /o/<slug> door and /login silently falls through to the generic sign-in. Operator-admin only; every call is audited to operator_actions.';
