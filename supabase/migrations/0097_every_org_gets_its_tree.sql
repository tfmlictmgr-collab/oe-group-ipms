-- The geopolitical tree becomes something every org GETS, not something one
-- migration once did.
--
-- Decision 8 states it plainly: Nigeria's cities are seeded as locations under
-- the three regions "for **every** live org". `0087` delivered that with a
-- one-off backfill — correct for every org that existed at the time, and silently
-- false for every org created afterwards.
--
-- The service-charge client (0094) is the first org to land on the wrong side of
-- that line: created after the backfill, it has **zero** hierarchy nodes while
-- TFML, OEA and the POC each carry twenty-eight. And it is not a special case —
-- `operator_provision_org()` is the function the operator portal uses to onboard
-- every future client, and it seeds the B7 permission matrix and the module flags
-- but never the tree. Every client onboarded through the product would have
-- arrived the same way.
--
-- ⚠️ **The invariant was enforced by a backfill, and a backfill only holds until
-- the next INSERT.** 0087's own comment says "a structure that exists for two orgs
-- out of three is a structure nobody trusts" — that reasoning does not stop
-- applying when the count changes from two-of-three to four-of-five. So the
-- seeding moves into a function that provisioning calls, and the backfill below
-- becomes a catch-up for the orgs that missed it rather than the mechanism.

-- ── The seeding, as something callable ────────────────────────────────────
--
-- Idempotent by construction: every insert is guarded by a NOT EXISTS on the
-- name it is about to create, so calling it twice adds nothing and calling it on
-- a half-built tree fills only the gaps. That matters because an FM may already
-- have created "Lagos" by hand before anyone runs this — decision 8 gives them
-- `hierarchy.write` precisely so they are not blocked waiting for a seed.
create or replace function seed_org_hierarchy(p_org_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_before integer;
  v_after  integer;
begin
  if p_org_id is null then
    raise exception 'seed_org_hierarchy needs an organisation';
  end if;

  -- The operator holds no client data (0088). A region filed against the control
  -- plane is exactly the "just one row" that erodes that separation.
  if exists (select 1 from orgs where id = p_org_id and is_platform_operator) then
    return 0;
  end if;

  select count(*) into v_before from org_nodes where org_id = p_org_id;

  -- Three regions, per the board's mapping rather than the six federal zones.
  insert into org_nodes (org_id, parent_id, level, name, code, path)
    select p_org_id, null, 'region', r.name, r.code, ''
      from (values ('North', 'NR'), ('South', 'ST'), ('East', 'ET')) as r(name, code)
     where not exists (
       select 1 from org_nodes n
        where n.org_id = p_org_id and n.level = 'region'
          and lower(n.name) = lower(r.name) and n.deleted_at is null
     );

  -- Cities as LOCATIONS directly under their region — the v3.4 order (0087).
  -- A starting point a manager edits, not a fixed list.
  insert into org_nodes (org_id, parent_id, level, name, path)
    select reg.org_id, reg.id, 'location', loc.name, ''
      from org_nodes reg
      join (values
        ('North', 'Abuja'), ('North', 'Kano'), ('North', 'Kaduna'),
        ('North', 'Sokoto'), ('North', 'Jos'), ('North', 'Maiduguri'),
        ('North', 'Ilorin'), ('North', 'Katsina'),
        ('South', 'Lagos'), ('South', 'Ibadan'), ('South', 'Benin City'),
        ('South', 'Abeokuta'), ('South', 'Akure'), ('South', 'Osogbo'),
        ('South', 'Warri'),
        ('East', 'Port Harcourt'), ('East', 'Enugu'), ('East', 'Owerri'),
        ('East', 'Aba'), ('East', 'Onitsha'), ('East', 'Awka'),
        ('East', 'Calabar'), ('East', 'Uyo'), ('East', 'Yenagoa'),
        ('East', 'Umuahia')
      ) as loc(region, name) on loc.region = reg.name
     where reg.org_id = p_org_id
       and reg.level = 'region'
       and reg.deleted_at is null
       and not exists (
         select 1 from org_nodes n
          where n.org_id = reg.org_id and n.parent_id = reg.id
            and lower(n.name) = lower(loc.name) and n.deleted_at is null
       );

  select count(*) into v_after from org_nodes where org_id = p_org_id;
  return v_after - v_before;
end;
$$;

revoke all on function seed_org_hierarchy(uuid) from public;
grant execute on function seed_org_hierarchy(uuid) to service_role;

comment on function seed_org_hierarchy is
  'Seeds the three regions and Nigeria''s major cities as locations for one org, in the v3.4 REGION → LOCATION → PROJECT → SITE order. Idempotent: fills gaps, never duplicates, and returns how many nodes it added. Called by operator_provision_org so the tree is something an org GETS rather than something a one-off migration once did.';

-- ── Provisioning seeds it from now on ─────────────────────────────────────
--
-- Rewritten from 0079b, which is the live definition. The only change is the
-- `seed_org_hierarchy` call — everything else is carried across verbatim so this
-- migration cannot quietly alter provisioning's other behaviour.
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
  v_caller   uuid := auth.uid();
  v_operator uuid := current_user_org_id();
  v_org      uuid;
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

  insert into orgs (name, delivery_brand)
  values (trim(p_name), p_delivery_brand::delivery_brand)
  returning id into v_org;

  perform seed_b7_permissions(v_org);

  insert into org_modules (org_id, module, enabled)
  values (v_org, 'lettings', p_delivery_brand = 'OEA')
  on conflict do nothing;

  -- New: the org arrives with somewhere to file its first property.
  perform seed_org_hierarchy(v_org);

  insert into invitations (org_id, email, role, full_name, token_hash, invited_by, expires_at)
  values (v_org, lower(trim(p_admin_email)), 'admin', nullif(trim(p_admin_name), ''),
          p_token_hash, v_caller, now() + interval '14 days');

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, coalesce(v_operator, v_org), v_org, 'provision_org', trim(p_reason),
          jsonb_build_object('name', trim(p_name), 'brand', p_delivery_brand,
                             'first_admin', lower(trim(p_admin_email))));

  return v_org;
end;
$$;

-- ── Catch up the orgs that missed the one-off ─────────────────────────────
--
-- A catch-up, not the mechanism. Today this is the service-charge client; if it
-- ever silently does more than that again, the cause is another path that
-- creates orgs without going through provisioning.
do $$
declare
  o record;
  n integer;
begin
  for o in
    select id, name from orgs
     where deleted_at is null and not is_platform_operator
  loop
    n := seed_org_hierarchy(o.id);
    if n > 0 then
      raise notice 'seeded % hierarchy node(s) for %', n, o.name;
    end if;
  end loop;
end $$;
