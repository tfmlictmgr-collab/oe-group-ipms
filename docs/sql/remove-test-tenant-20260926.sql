-- Remove the OEA test tenant created on production, 26 Sept 2026.
--
-- Found 27 Sept by the emptiness re-check during the self-assessment: users
-- 3 → 4 and invitations 2 → 4. OEA's administrator invited a tenant twice on
-- production: first a gmail.com address (13:00 UTC, revoked), then an
-- @oegroup.test fixture address (23:48, accepted, account created 23:49). No
-- property, unit or lease is linked. A test account, and "production is never
-- seeded", so it goes. The gmail invitation goes too, because it still stores
-- a real person's address.
--
-- Run in the PRODUCTION SQL editor (civwriqvghvyqtfrzftu in the address bar).
-- All-or-nothing: if anything refers to the test account, NOTHING is changed
-- and the error names what blocked it.

-- ── Part 1: look (reads only) ────────────────────────────────────────────
select u.id, u.role::text, u.created_at, u.email like '%@oegroup.test' as is_fixture_address
  from users u join orgs o on o.id = u.org_id
 where o.slug = 'oea' and u.role = 'tenant';

-- ── Part 2: remove (one atomic block) ────────────────────────────────────
do $$
declare
  v_user uuid;
  v_n int;
begin
  select count(*) into v_n from users u join orgs o on o.id = u.org_id
   where o.slug = 'oea' and u.role = 'tenant';
  if v_n <> 1 then
    raise exception 'Expected exactly ONE OEA tenant account, found %. Stop and look.', v_n;
  end if;
  select u.id into v_user from users u join orgs o on o.id = u.org_id
   where o.slug = 'oea' and u.role = 'tenant' and u.email like '%@oegroup.test';
  if v_user is null then
    raise exception 'The OEA tenant is NOT on the @oegroup.test fixture domain — it may be a real person. Nothing deleted.';
  end if;

  select count(*) into v_n from invitations i join orgs o on o.id = i.org_id
   where o.slug = 'oea' and i.role = 'tenant';
  if v_n <> 2 then
    raise exception 'Expected the two OEA tenant invitations, found %. Nothing deleted.', v_n;
  end if;

  delete from invitations i using orgs o
   where o.id = i.org_id and o.slug = 'oea' and i.role = 'tenant';
  -- A foreign-key error here names the table still pointing at the account;
  -- the whole block then rolls back, invitations included.
  delete from users where id = v_user;
end $$;

-- ── Part 3: prove it (reads only) ────────────────────────────────────────
-- Expect users 3, invitations 2 — the 22 Sept administrators and nothing else.
select 'users' t, count(*) from users
union all select 'invitations', count(*) from invitations
union all select 'OEA tenants', count(*) from users u join orgs o on o.id = u.org_id where o.slug = 'oea' and u.role = 'tenant';
