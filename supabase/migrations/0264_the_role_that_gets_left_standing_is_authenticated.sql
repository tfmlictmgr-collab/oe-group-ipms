-- The role that gets left standing is `authenticated`.
--
-- `verify-function-grants` §A reported one over-granted function:
--
--     ensure_property_ledger_account → authenticated
--
-- 0247 line 713 revokes it from `public, anon` and grants it to `service_role`
-- alone, and its own header says so. Both statements ran. The function was
-- still executable by every signed-in user in every organisation, because
-- Supabase's DEFAULT PRIVILEGES on the public schema grant EXECUTE on each new
-- function to `anon`, `authenticated` AND `service_role` — and a
-- `revoke ... from public, anon` takes two of the three.
--
-- ⚠️ This is the FOURTH instance of one pattern in this repo. 0204 recorded it,
-- 0209 was written specifically to record it again, 0210 reproduced it four
-- files later by an author who had just read both, and 0263 hit it on its first
-- run this week. Every previous instance was about `anon`, so the muscle memory
-- that formed was "remember to revoke from anon" — which is precisely the
-- reflex that leaves this one open. **`public` and `anon` are not the list.**
--
-- What it exposed: a SECURITY DEFINER function that CREATES a ledger account,
-- callable by any authenticated user with a caller-supplied org id, purpose and
-- property. It is only ever called from inside `canonical_ledger_account` and
-- 0247's own reallocation, both of which are definer functions running as the
-- table owner and needing no grant of their own. So nothing loses anything.
--
-- 📌 The lesson that outlives the instance is not "revoke harder" — it is that
-- prose in a migration header did not prevent occurrences two, three or four,
-- and the SUITE caught every one of them. `verify-function-grants` compares the
-- live catalogue against what each migration declared, which is the only check
-- that can see a grant nobody wrote.

revoke all on function ensure_property_ledger_account(
  uuid, ledger_account_purpose, uuid, text
) from public, anon, authenticated;

grant execute on function ensure_property_ledger_account(
  uuid, ledger_account_purpose, uuid, text
) to service_role;

comment on function ensure_property_ledger_account(uuid, ledger_account_purpose, uuid, text) is
  'Resolves (creating if needed) the per-property sub-account for a property-scoped ledger purpose (0247). Service-role only -- and `authenticated` had to be revoked EXPLICITLY in 0264, because Supabase''s default privileges grant it and 0247''s `revoke ... from public, anon` left it standing.';
