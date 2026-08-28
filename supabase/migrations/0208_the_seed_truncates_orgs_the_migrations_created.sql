-- `npm run seed` destroys two organisations that migrations created, and only
-- ever puts three back.
--
-- `scripts/seed.mjs` opens with
--
--     truncate table ... users, orgs restart identity cascade;
--
-- and then inserts the POC, TFML and OEA. Two organisations do not come from
-- the seed at all:
--
--   * `oe-group` — the PLATFORM OPERATOR (`0088`). The control plane. Holds
--     `is_platform_operator`, and with it decision 7's single deliberate
--     crossing of org isolation.
--   * `sc-client` — the SERVICE-CHARGE CLIENT (`0094`). The organisation the
--     entire brief is about: the entity whose vendors OE Group pays on its
--     behalf, and the only org carrying `org_brand_associations` to both
--     brands.
--
-- Both were created by a migration, and a migration runs once. Truncating the
-- table removes them permanently; nothing notices, because every consumer
-- filters `is('deleted_at', null)` and simply finds nothing.
--
-- Observed on staging, seeded 19 Aug 2026: `sc-client` is gone. Nine checks in
-- `verify-sc-client` stop at "the service-charge client org exists" and the
-- whole B4 chain the client engagement exists to demonstrate has no client to
-- demonstrate it for. The operator org survived only because somebody
-- re-created it by hand thirteen minutes after the seed.
--
-- 📌 Fourth instance of the family `0205`-`0207` record, arriving from the
-- opposite direction: not "a one-off backfill that never runs again", but "a
-- one-off backfill whose rows a later command deletes". The common cause is
-- the same — **a row that must always exist, stated in a place that only
-- executes once.** The answer is the same too: put it in a function, and let
-- both the migration and the seed call it.

-- ---- The two organisations the platform owns ------------------------------
--
-- Idempotent, and deliberately NOT `operator_provision_org`: that function is
-- the operator-admin path for onboarding a CLIENT, audits itself to
-- `operator_actions`, and mints an admin invitation. These two orgs are part of
-- the platform's own shape. Their bodies are `0088`'s and `0094`'s, unchanged,
-- so re-creating one produces exactly the row the migration produced.
create or replace function ensure_platform_orgs()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_op  uuid;
  v_sc  uuid;
begin
  -- The operator (0088). Holds no client data; the trigger from that migration
  -- keeps it that way.
  insert into orgs (name, delivery_brand, slug, portal_name, tagline,
                    theme_primary, theme_logo_text, login_headline)
    select 'OE Group', 'direct', 'oe-group', 'OE Group Platform',
           'The organisations OE Group administers.',
           '#8b1d1d', 'OE',
           'Sign in to the OE Group platform.'
     where not exists (
       select 1 from orgs where lower(slug) = 'oe-group' and deleted_at is null
     );

  select id into v_op from orgs where lower(slug) = 'oe-group' and deleted_at is null;

  -- Two statements, as 0088 explains: `orgs_single_operator_uidx` permits at
  -- most one operator ever, so a single UPDATE would transiently hold two and
  -- the index would refuse it.
  if not exists (select 1 from orgs where is_platform_operator and id = v_op) then
    update orgs set is_platform_operator = false where is_platform_operator;
    update orgs set is_platform_operator = true where id = v_op;
  end if;

  perform seed_b7_permissions(v_op);
  perform seed_application_document_requirements(v_op);
  insert into org_modules (org_id, module, enabled)
  values (v_op, 'lettings', false), (v_op, 'ai_document_checks', false)
  on conflict (org_id, module) do nothing;

  -- The service-charge client (0094). `delivery_brand = 'direct'` and
  -- `parent_org_id` null: fully independent, nested under neither brand, which
  -- is what makes the association rows below meaningful rather than decorative.
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

  select id into v_sc from orgs where lower(slug) = 'sc-client' and deleted_at is null;

  insert into org_brand_associations (org_id, brand, engagement) values
    (v_sc, 'TFML', 'service charge management'),
    (v_sc, 'OEA',  'service charge administration')
  on conflict (org_id, brand, engagement) do nothing;

  perform seed_b7_permissions(v_sc);
  perform seed_application_document_requirements(v_sc);
  insert into org_modules (org_id, module, enabled)
  values (v_sc, 'lettings', false), (v_sc, 'ai_document_checks', false)
  on conflict (org_id, module) do nothing;

  perform seed_org_hierarchy(v_sc);
end;
$$;

revoke all on function ensure_platform_orgs() from public, anon, authenticated;
grant execute on function ensure_platform_orgs() to service_role;

comment on function ensure_platform_orgs is
  'The operator org (0088) and the service-charge client (0094), created if absent. Both were one-off migration inserts that `npm run seed` truncated away and never restored; the seed now calls this straight after its truncate (0208). Idempotent, and not a substitute for operator_provision_org, which onboards a CLIENT and audits itself.';

-- ---- Restore whatever this world has lost ---------------------------------
select ensure_platform_orgs();

-- ---- The guard ------------------------------------------------------------
do $guard$
declare
  v_ops integer;
begin
  select count(*) into v_ops
    from orgs where lower(slug) in ('oe-group', 'sc-client') and deleted_at is null;
  if v_ops <> 2 then
    raise exception
      'expected the operator org and the service-charge client to both exist, found %', v_ops;
  end if;

  if not exists (
    select 1 from orgs where lower(slug) = 'oe-group'
       and deleted_at is null and is_platform_operator
  ) then
    raise exception 'the operator organisation does not hold is_platform_operator';
  end if;

  if (select count(*) from org_brand_associations a
        join orgs o on o.id = a.org_id
       where lower(o.slug) = 'sc-client') <> 2 then
    raise exception 'the service-charge client is not associated to both brands';
  end if;
end;
$guard$;
