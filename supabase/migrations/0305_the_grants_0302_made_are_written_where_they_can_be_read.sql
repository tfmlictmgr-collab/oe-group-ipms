-- The grants 0302 made, written where they can be read (27 Sept 2026, rc8 cut).
--
-- `0302` grants eight "who is the caller?" functions to `anon`, deliberately:
-- Realtime evaluates each published table's policy as EVERY subscriber's role,
-- and one unsigned subscriber raising "permission denied for function
-- active_uid" silenced live updates for everybody (found on production,
-- 25 Sept). Its header explains, function by function, why each fails closed
-- for a caller with no identity.
--
-- But it issued those grants from inside a loop, with `format()`. The one
-- place that compares every function's LIVE grants against what the
-- migrations declare — `scripts/verify-function-grants.mjs` — reads literal
-- `grant execute on function f(...) to …;` statements, and cannot read a loop.
-- So on any world holding 0302 it reported four of them as over-granted to
-- anon: active_uid, current_user_payable_ticket_ids, current_user_vendor_ids,
-- has_permission.
--
-- It went unnoticed at rc7 because staging never received 0302: migrations
-- there were stuck behind `0213a` until the rc8 cut (see 0213a's amendment).
-- Production has held 0302, and therefore this discrepancy, since 25 Sept.
--
-- 📌 This changes NOTHING on any database. Every grant below is already held
-- wherever 0302 ran, and granting a privilege already held is a no-op. It
-- exists so the declaration is legible to the check that audits it — the
-- alternative, teaching the check to evaluate loops, would make an auditing
-- tool clever in exactly the place it needs to be dull.
--
-- Only the four the check flagged are restated. The other four 0302 names
-- (current_user_org_id, current_user_role, current_user_property_ids,
-- fm_roles) have no literal grant anywhere, so the check does not audit them;
-- declaring an anon grant for them here would make it start auditing them
-- against an incomplete declaration (they are also granted to authenticated
-- by Supabase's defaults) and fail the other way.
--
-- Written without the schema prefix on purpose: the check's reader matches
-- `grant execute on function name(...)`.

grant execute on function active_uid()                        to anon;
grant execute on function current_user_vendor_ids()           to anon;
grant execute on function current_user_payable_ticket_ids()   to anon;
grant execute on function has_permission(text)                to anon;
