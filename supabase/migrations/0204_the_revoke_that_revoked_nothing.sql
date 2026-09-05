-- The revoke that revoked nothing.
--
-- 🚨 `scripts/verify-function-grants.mjs` compares what every migration SAID it
-- was granting against what Postgres actually grants, and found six functions
-- still executable by `anon` though their own migrations never intended it:
--
--   create_units, end_tenancy, expire_due_leases, unit_is_vacant,
--   vacant_unit_ids, vacant_units_for_property
--
-- All six (0200, 0201) wrote the same pattern:
--
--     revoke all on function f(...) from public;
--     grant execute on function f(...) to authenticated, service_role;
--
-- `PUBLIC` is the pseudo-role meaning "everyone by default". Supabase writes
-- EXPLICIT default-privilege grants to `anon` and `authenticated` at function
-- creation time, which `revoke ... from public` never touches — the revoke ran,
-- succeeded, and removed nothing. The `grant ... to authenticated` half of each
-- statement then landed correctly, so the defect was invisible from the SQL
-- alone: every migration read as doing exactly what it said, while `anon` kept
-- standing execute rights it was never supposed to have. This is the exact
-- defect 0114 closed for a different 101 functions — these six were added
-- afterwards, by migrations that repeated the pre-0114 pattern rather than
-- 0114's fix.
--
-- 📌 What each of these does if called by an unauthenticated request: create
-- unit rows on any property, end a tenancy, force-expire leases org-wide,
-- and read vacancy/unit-id data — none of it behind a login. Closed the same
-- way as 0114: explicit `revoke execute ... from anon`, then proved rather
-- than assumed.

revoke execute on function create_units(uuid, jsonb)          from anon;
revoke execute on function end_tenancy(uuid, text)            from anon;
revoke execute on function expire_due_leases(uuid)             from anon;
revoke execute on function unit_is_vacant(uuid)                from anon;
revoke execute on function vacant_unit_ids(uuid[])              from anon;
revoke execute on function vacant_units_for_property(uuid)     from anon;

-- Re-stated rather than assumed: a signed-in user still has what the app
-- needs. Each of these already had it (0200/0201); restating costs nothing
-- and documents the intended end state in the one migration that changed it.
grant execute on function create_units(uuid, jsonb)          to authenticated, service_role;
grant execute on function end_tenancy(uuid, text)            to authenticated, service_role;
grant execute on function expire_due_leases(uuid)             to authenticated, service_role;
grant execute on function unit_is_vacant(uuid)                to authenticated, service_role;
grant execute on function vacant_unit_ids(uuid[])              to authenticated, service_role;
grant execute on function vacant_units_for_property(uuid)     to authenticated, service_role;

-- ── Prove it ─────────────────────────────────────────────────────────────
do $$
declare
  v_over text;
begin
  select string_agg(p.proname, ', ') into v_over
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_units', 'end_tenancy', 'expire_due_leases',
                        'unit_is_vacant', 'vacant_unit_ids', 'vacant_units_for_property')
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_over is not null then
    raise exception 'anon can still execute: %', v_over;
  end if;
end;
$$;
