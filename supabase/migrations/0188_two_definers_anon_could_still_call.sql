-- Two SECURITY DEFINER functions were still executable by `anon`.
--
-- Caught by `verify-function-grants` on the full sweep:
--
--     FAIL 2 over-granted: lease_tenancy_chain → anon, operator_provision_org → anon
--
-- Neither arrives from the FM/PM work in 0182–0187; both predate it, and both
-- are the SAME MISTAKE `0154` already has a migration and a title for:
-- **a revoke from PUBLIC does not touch anon.**
--
--   * `lease_tenancy_chain` (0181) ends with
--
--         revoke all on function lease_tenancy_chain(uuid) from public;
--         grant execute on function lease_tenancy_chain(uuid) to authenticated, service_role;
--
--     which reads as though it locks the function down and does not. In
--     Supabase `anon` is a role of its own holding its own grant; revoking the
--     PUBLIC grant leaves anon's intact. The house pattern — used correctly by
--     `raise_work_order`, `create_property`, `log_asset_running_hours` and
--     roughly a hundred others — names all three: `from public, anon, authenticated`.
--
--   * `operator_provision_org` (0097/0176/0177) never revoked anything at all.
--     `create or replace` PRESERVES existing grants, so each rewrite carried
--     the original PUBLIC EXECUTE forward untouched, and the sweep in commit
--     5057880 ("101 of 103 SECURITY DEFINER functions were callable by anon")
--     evidently missed it.
--
-- ── How bad, stated honestly ──────────────────────────────────────────────
--
-- Not exploitable on its own. `operator_provision_org` opens with
-- `if not caller_is_operator_admin() then raise`, and an anonymous caller has
-- no `auth.uid()`, so it refuses before it does anything. `lease_tenancy_chain`
-- is a read whose own body is org-scoped.
--
-- 📌 That is exactly why it survived: **the inner check is what makes the outer
-- one look unnecessary.** Defence in depth is not a spare check, it is the one
-- that still holds after somebody edits the first — and `operator_provision_org`
-- is the function that CREATES ORGANISATIONS. It should never have been one
-- refactor away from anonymous reach.
--
-- Grants only; no function body changes.

revoke all on function lease_tenancy_chain(uuid) from public, anon;
grant execute on function lease_tenancy_chain(uuid) to authenticated, service_role;

revoke all on function operator_provision_org(text, text, text, text, text, text)
  from public, anon;
grant execute on function operator_provision_org(text, text, text, text, text, text)
  to authenticated, service_role;
