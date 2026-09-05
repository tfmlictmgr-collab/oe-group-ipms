-- The revoke that revoked nothing. Third occurrence, four files after 0209.
--
-- `0210` created five functions and wrote, for each of them:
--
--     revoke all on function ... from public;
--     grant execute on function ... to service_role;
--
-- which is the exact form `0114`, `0154`, `0204` and `0209` all exist to
-- correct. Supabase writes EXPLICIT default-privilege grants to **`anon` and
-- `authenticated`** when a function is created. `revoke ... from public` does
-- not touch an explicit grant to a named role, so all five functions were left
-- callable by any browser session and by any unauthenticated visitor holding
-- the publishable anon key — which is printed in the page source of every
-- portal, by design.
--
-- ⚠️ What that got them, concretely, is worse than the previous two:
--
--   • `sender_open_requests(org, sender_ref)` — every open request belonging to
--     any phone number, in any organisation, to anyone who guessed a number.
--     Both arguments are caller-supplied and the function is SECURITY DEFINER,
--     so RLS never runs. Nigerian mobile numbers are an enumerable space.
--   • `resolve_ticket_by_ref(org, sender_ref, ref)` — the same, keyed on a
--     reference instead. Its ownership guard checks the ref against the
--     sender_ref, and an anonymous caller supplies BOTH, so the guard proves
--     nothing.
--   • `remember_conversation_state(...)` — a WRITE. An anonymous caller could
--     point any sender's conversation at any ticket id, so their next WhatsApp
--     message would append to a stranger's request.
--
-- The B1 isolation rule falls to the same argument: `p_org_id` is an argument,
-- so nothing confined a caller to one brand.
--
-- 📌 The lesson `0209` already drew, holding for a third time and now with a
-- much larger blast radius: **prose in a migration header does not prevent the
-- next occurrence.** The author of `0210` had read `0204` and `0209` in the
-- same session and reproduced the pattern anyway. What actually caught it was
-- a suite asserting the property against a live anon client
-- (`verify-conversational-intelligence.mjs`, section I) — within minutes, and
-- before the code left a local machine.
--
-- So the durable fix is not another paragraph. It is that **every new
-- service-role function now ships with the guard below in its own migration**,
-- so a wrong revoke fails the migration instead of shipping. `0210` has been
-- amended in place to the correct form as well, so a world created from a fresh
-- run of the migration set never has the window at all; this file exists for
-- the two worlds that already applied the original.

revoke execute on function sender_open_requests(uuid, text, integer) from anon, authenticated;
revoke execute on function resolve_ticket_by_ref(uuid, text, text) from anon, authenticated;
revoke execute on function conversation_state(uuid, text, text) from anon, authenticated;
revoke execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) from anon, authenticated;

-- `remember_conversation` (0075) was correctly revoked by 0114 and then RE-
-- GRANTED by 0210's `create or replace`: replacing a function re-applies
-- Supabase's default privileges, so a fix from four months ago was quietly
-- undone by an unrelated edit today. Anything `create or replace`d must have
-- its revoke re-stated in the same migration, every time — the grant is a
-- property of the current definition, not of the name.
revoke execute on function remember_conversation(uuid, text, text, uuid, text, integer) from anon, authenticated;

-- Re-stated rather than assumed. All five are called from the WhatsApp and
-- Telegram webhook handlers, which hold the service role; none is reachable
-- from a signed-in session by design.
grant execute on function sender_open_requests(uuid, text, integer) to service_role;
grant execute on function resolve_ticket_by_ref(uuid, text, text) to service_role;
grant execute on function conversation_state(uuid, text, text) to service_role;
grant execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) to service_role;
grant execute on function remember_conversation(uuid, text, text, uuid, text, integer) to service_role;

-- The guard, proving it rather than declaring it — 0204's closing move, now
-- covering the whole set rather than one function. A migration that leaves any
-- of them reachable does not apply.
do $guard$
declare
  v_leak text;
begin
  select string_agg(format('%s → %s', g.routine_name, g.grantee), ', ' order by g.routine_name)
    into v_leak
    from information_schema.routine_privileges g
   where g.routine_name in (
           'sender_open_requests', 'resolve_ticket_by_ref', 'conversation_state',
           'remember_conversation_state', 'remember_conversation'
         )
     and g.privilege_type = 'EXECUTE'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC');

  if v_leak is not null then
    raise exception 'conversational-intake functions still executable: %', v_leak;
  end if;
end;
$guard$;
