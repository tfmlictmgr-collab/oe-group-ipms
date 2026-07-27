-- SECURITY FIX — `channel_routes.external_id` is a credential, and every signed-in
-- user in the org could read it.
--
-- The policy was:
--     create policy channel_routes_select on channel_routes for select
--       using (org_id = current_user_org_id());
--
-- No role test. So a TENANT could read it — and for Telegram, `external_id` is
-- the per-bot secret token that Telegram echoes on every webhook. That token is
-- simultaneously the authentication and the routing key:
--
--     const headerToken = request.headers.get("x-telegram-bot-api-secret-token");
--     const route = await resolveOrgForChannel("telegram", headerToken);
--
-- Anyone holding it can forge inbound service requests against the org, choose
-- which org they land in, and attribute them to any sender. For WhatsApp the
-- same column holds the `phone_number_id`, which is less sensitive but still
-- routing infrastructure that no portal user has any reason to enumerate.
--
-- Found by the read-only-observer verification (0038/scripts/verify-viewer-
-- access.mjs), which asserted that an external reviewer sees no infrastructure
-- and got a row back. The viewer role did not cause this; it revealed it.
--
-- The fix is removal, not restriction. `resolveOrgForChannel` runs under the
-- SERVICE ROLE inside the webhook handlers, which bypasses RLS, and no UI reads
-- this table under a user session. The policy therefore granted access that
-- nothing needed — the strongest kind of permission to delete.

drop policy if exists channel_routes_select on channel_routes;

-- RLS stays enabled with no policies at all: deny to every client role, allow
-- the service role (which bypasses RLS by design). Provisioning was already
-- service-role-only, so writes are unchanged.
revoke all on table channel_routes from anon, authenticated;

comment on table channel_routes is
  'Inbound channel identity -> org. external_id is a CREDENTIAL for Telegram (the webhook secret token), so this table is service-role only: no RLS policies, no grants to anon/authenticated. Do not add a SELECT policy without re-reading 0039.';
