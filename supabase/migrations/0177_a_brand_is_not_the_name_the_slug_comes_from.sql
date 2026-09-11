-- 0176 mirrored 0085's backfill too literally.
--
-- 0085's backfill special-cased delivery_brand = 'TFML'/'OEA' to the bare
-- slugs 'tfml'/'oea' — correct THERE, because at backfill time there was
-- exactly one live row per brand, so "the org with this delivery_brand" and
-- "the org named TFML/OEA" were the same row. 0176 carried that special case
-- into ongoing provisioning, where they are not the same thing — 0085's own
-- comment says it outright: delivery_brand "says which brand delivers the
-- work, not which organisation this is." Provisioning a brand-new
-- OEA-delivered client produced slug 'oea-2', its own name discarded, purely
-- because it shared a brand with the real OEA org. verify-org-creation.mjs
-- caught it on the first run.
--
-- The fix: slug always derives from the org's own name. TFML and OEA keep
-- their 'tfml'/'oea' addresses because 0085 already set them on those
-- specific rows and nothing here rewrites an existing slug — a future org
-- merely delivered by the same brand is named, and slugged, on its own terms.
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

  v_base_slug := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
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

-- Grants are unchanged from 0176 (create or replace keeps them) — repeated
-- here only in comment form, not in SQL, so this migration cannot silently
-- widen access if it is ever copied as a template.

comment on function operator_provision_org is
  'Provisions a new organisation: seeds the B7 permission baseline, the lettings flag from its brand, its geopolitical hierarchy and an admin invitation — and a unique slug derived from the org''s own name (0177; corrects 0176, which slugged TFML/OEA-branded orgs from the brand instead of the name they were actually given). TFML and OEA keep the addresses 0085 backfilled onto those two specific rows; this never rewrites an existing slug. Operator-admin only; every call is audited to operator_actions.';
