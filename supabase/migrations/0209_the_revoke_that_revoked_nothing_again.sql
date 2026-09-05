-- The revoke that revoked nothing, again — this time in 0206, five files after
-- 0204 explained it.
--
-- `0206` created `seed_application_document_requirements(uuid)` and wrote
--
--     revoke all on function ... from public, anon;
--     grant execute on function ... to service_role;
--
-- naming `public` and `anon` and forgetting `authenticated`. Supabase writes
-- EXPLICIT default-privilege grants to BOTH `anon` and `authenticated` when a
-- function is created, and `revoke ... from public` touches neither — that is
-- the whole of `0114`, `0154` and `0204`. Naming `anon` closed half of it and
-- left every signed-in user able to call it.
--
-- What that gets them is small — the function only inserts the six standard
-- document requirements `on conflict do nothing`, for an org id they pass in,
-- and cannot change or delete an existing row. It is nonetheless a
-- `security definer` function reachable across organisations by anyone with a
-- login, which is not what the migration said it was doing.
--
-- 📌 The point is not this function. It is that the pattern re-appeared
-- IMMEDIATELY after a migration was written specifically to record it, in a
-- file written by someone who had just read that migration. Prose in a
-- migration header does not prevent the next occurrence;
-- `verify-function-grants` caught this one within the hour, which is the actual
-- control. **The guard is the thing that works — keep running it, and read the
-- one line it prints.**

revoke execute on function seed_application_document_requirements(uuid) from anon, authenticated;

-- Re-stated rather than assumed. Nothing in the application calls this from a
-- session; it is called by `operator_provision_org` (a definer function, which
-- runs as its owner) and by `ensure_platform_orgs`.
grant execute on function seed_application_document_requirements(uuid) to service_role;

-- The guard, proving it rather than declaring it — 0204's closing move.
do $guard$
declare
  v_leak text;
begin
  select string_agg(g.grantee, ', ') into v_leak
    from information_schema.routine_privileges g
   where g.routine_name = 'seed_application_document_requirements'
     and g.privilege_type = 'EXECUTE'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC');

  if v_leak is not null then
    raise exception
      'seed_application_document_requirements is still executable by %', v_leak;
  end if;
end;
$guard$;
