-- The fourth occurrence, and the first one that only a fresh database could
-- find.
--
-- `0214` refused to apply against the production project on 21 Sept 2026:
--
--   conversational-intake functions still executable:
--     conversation_state → PUBLIC, remember_conversation_state → PUBLIC,
--     resolve_ticket_by_ref → PUBLIC, sender_open_requests → PUBLIC
--
-- That is `0214`'s own guard doing precisely its job, against the first world
-- ever built from these files alone.
--
-- ── Why it passed on dev and staging and fails here ────────────────────────
--
-- `0214`'s header records that `0210` "has been amended in place to the
-- correct form as well, so a world created from a fresh run of the migration
-- set never has the window at all". That sentence is **false**, and this file
-- exists because of it.
--
-- The amendment changed `0210`'s five revokes from
--
--     revoke all on function ... from public;
--
-- to
--
--     revoke execute on function ... from anon, authenticated;
--
-- which fixes the leak `0214` was written about — the explicit grants Supabase
-- writes to `anon` and `authenticated` — and silently drops the revoke of the
-- privilege PostgreSQL grants on its own. **A newly created function is
-- EXECUTE-able by PUBLIC by default.** So the amended `0210` leaves PUBLIC
-- holding exactly what the original had removed, and `0214`'s guard checks all
-- three grantees, so it catches it.
--
-- Dev and staging never saw this because they applied the ORIGINAL `0210`,
-- whose `revoke all ... from public` did remove it. Both worlds are clean by
-- having run a version of the file that no longer exists in this repository.
--
-- 📌 The one function NOT in the failure list proves the mechanism rather than
-- leaving it a theory. `remember_conversation` is named in the same revoke
-- block and is absent from the error, because it was created back in `0075`,
-- revoked from PUBLIC by `0114`, and `0210` only `create or replace`d it —
-- and a replace PRESERVES privileges. The four that failed are the four
-- `0210` created for the first time.
--
-- ── Why this is a new file and not another amendment to 0210 ───────────────
--
-- Amending `0210` again cannot fix any world: all three have it committed in
-- `_migrations`, so it will never run again anywhere. Only a file that has not
-- yet been applied can repair this — and amending in place is the move that
-- caused the defect, so repeating it here would be the fifth occurrence rather
-- than the end of the fourth.
--
-- The number is `0213a` rather than `0301` because this has to run BEFORE
-- `0214`, which is where the guard is. Production stopped at `0214` and will
-- retry it on the next run; a `0301` would never be reached. Suffixed numbers
-- state an order rather than leaving it inferred, which is what
-- `migrate.mjs` asks of them.
--
-- On dev and staging this applies out of order, after `0300`, and is a no-op:
-- revoking a privilege nobody holds changes nothing. That is why it carries
-- its own guard rather than leaning on `0214`'s — on those two worlds `0214`
-- is long since applied and will not re-run, so nothing else would check this
-- file's work there.
--
-- ⚠️ Scope. This repairs the four functions `0214` names. It does not attempt
-- a general sweep of every function created without a revoke, because a static
-- read of the migration files cannot tell a genuine leak from one a later
-- blanket revoke already closed, nor a client-callable function from a trigger
-- function for which PUBLIC EXECUTE means nothing. The authoritative check is
-- against a live database, and it is now the fourth query in
-- `docs/sql/stage3-production-proof.sql`.

revoke execute on function sender_open_requests(uuid, text, integer)                              from public;
revoke execute on function resolve_ticket_by_ref(uuid, text, text)                                from public;
revoke execute on function conversation_state(uuid, text, text)                                   from public;
revoke execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) from public;

-- Re-stated, not assumed. Revoking from PUBLIC does not touch a grant held by
-- a named role, and these five are called only by the WhatsApp and Telegram
-- webhook handlers, which hold the service role.
grant execute on function sender_open_requests(uuid, text, integer)                              to service_role;
grant execute on function resolve_ticket_by_ref(uuid, text, text)                                to service_role;
grant execute on function conversation_state(uuid, text, text)                                   to service_role;
grant execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) to service_role;

-- The same guard shape 0204 introduced and 0214 generalised. It must hold on
-- every world this file reaches, including the two where it runs late and
-- 0214's copy will not run again.
do $guard$
declare
  v_leak text;
begin
  select string_agg(format('%s → %s', g.routine_name, g.grantee), ', ' order by g.routine_name)
    into v_leak
    from information_schema.routine_privileges g
   where g.routine_name in (
           'sender_open_requests', 'resolve_ticket_by_ref', 'conversation_state',
           'remember_conversation_state'
         )
     and g.privilege_type = 'EXECUTE'
     and g.grantee = 'PUBLIC';

  if v_leak is not null then
    raise exception 'conversational-intake functions still executable by PUBLIC: %', v_leak;
  end if;
end;
$guard$;
