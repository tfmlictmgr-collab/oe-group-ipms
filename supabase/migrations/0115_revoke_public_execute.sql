-- The SECOND root cause of the same exposure — and it is a different bug.
--
-- `0114` fixed functions where Supabase's default privileges had written an
-- EXPLICIT `anon` / `authenticated` grant that `revoke ... from public` never
-- touched. The regression guard added alongside it then immediately found two
-- functions still reachable by anon, for the opposite reason:
--
--     accept_invitation  acl: =X/postgres | authenticated=X | service_role=X
--     has_permission     acl: =X/postgres | authenticated=X | service_role=X
--                             ^^^^^^^^^^^ an EMPTY grantee is PUBLIC
--
-- Compare a function whose migration got it right:
--
--     record_collection  acl: postgres=X | service_role=X      (no PUBLIC entry)
--
-- These two never had `revoke all on function ... from public` written for
-- them at all. `has_permission` (0050) was granted and never revoked;
-- `accept_invitation` had a revoke written in 0020 — for the **two-argument**
-- signature, which 0026 then replaced with a seven-argument one that inherited
-- the default PUBLIC grant and no revoke. A revoke naming a signature that no
-- longer exists protects nothing, and nothing warns you.
--
-- So `0114`'s revokes were correct AND insufficient: revoking from `anon`
-- leaves PUBLIC, and PUBLIC includes anon. Both had to go.
--
-- ⚠️ Checked before revoking, because `has_permission` is called INSIDE RLS
-- policies: if an anonymous caller could not execute it, every anon query on a
-- table whose policy calls it would ERROR rather than return nothing — which
-- would break the public tenancy-application and vendor-application flows in a
-- way that only shows up when a real applicant tries. No anon-facing policy
-- calls it: the public flows gate on `org_accepts_tenant_applications` /
-- `org_accepts_vendor_applications`, which are granted to anon deliberately and
-- are untouched here. `authenticated` and `service_role` keep their explicit
-- grants, so every signed-in path is unaffected.
revoke execute on function has_permission(p_capability text) from public;

revoke execute on function accept_invitation(
  p_token_hash text, p_full_name text, p_phone text, p_telegram_chat_id text,
  p_notify_whatsapp boolean, p_notify_sms boolean, p_notify_telegram boolean
) from public;

-- Both keep exactly what their migrations declared.
grant execute on function has_permission(p_capability text) to authenticated, service_role;
grant execute on function accept_invitation(
  p_token_hash text, p_full_name text, p_phone text, p_telegram_chat_id text,
  p_notify_whatsapp boolean, p_notify_sms boolean, p_notify_telegram boolean
) to authenticated;
