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

-- ── Part 2: the account — through the app, NOT deleted ───────────────────
-- ⚠️ Tried first, 27 Sept: `delete from users` was refused by
-- audit_log_actor_id_fkey. The test account is an actor in the audit trail,
-- and audit_log is append-only by design (0005: no update, no delete). The
-- account is therefore retired the way every departed account is: signed in
-- as OEA's administrator on www.oeaportal.com, People → the tenant → Manage →
--   1. "Deactivate this account"
--   2. "Free up their email address"   (bans the sign-in; the address becomes a
--                                        dead placeholder; the record and its
--                                        trail stay, as they must)
-- Do NOT delete the user in Supabase → Authentication: that cascades to the
-- same refused delete.

-- ── Part 3: the two invitations (one atomic block) ─────────────────────────
-- The gmail one still stores a real person's address. Invitations carry no
-- audit foreign key, so they can go.
do $$
declare v_n int;
begin
  select count(*) into v_n from invitations i join orgs o on o.id = i.org_id
   where o.slug = 'oea' and i.role = 'tenant';
  if v_n <> 2 then
    raise exception 'Expected the two OEA tenant invitations, found %. Nothing deleted.', v_n;
  end if;
  delete from invitations i using orgs o
   where o.id = i.org_id and o.slug = 'oea' and i.role = 'tenant';
end $$;

-- ── Part 4: prove it (reads only) ────────────────────────────────────────
-- Expect: invitations 2 (the 22 Sept administrators); active users 3; the
-- test tenant present but deactivated AND released.
select 'invitations' t, count(*)::text v from invitations
union all select 'active users', count(*)::text from users where deactivated_at is null
union all select 'test tenant state',
       (select case when u.deactivated_at is not null and u.email_released_at is not null
                    then 'deactivated + released' else 'STILL ACTIVE OR NOT RELEASED' end
          from users u join orgs o on o.id = u.org_id where o.slug = 'oea' and u.role = 'tenant');
