-- Same D2 bug 0083c fixed, on two more columns.
--
-- 0146a (`whatsapp_number`) and 0147 (`telegram_bot_username`) each added a
-- column to `orgs` that Settings → Lettings/Channels writes through the
-- signed-in administrator's own session — but neither migration extended the
-- 0083c UPDATE column allowlist, so both arrived unwritable by anyone but the
-- service role. Found by `verify-lettings-grants.mjs` section C, which exists
-- precisely to catch a new column landing unclassified.
--
-- `gateway_tag` (0156) is deliberately NOT granted here: it is DB-generated
-- (backfilled by migration, read via payment_reference_org_tag()) and never
-- written by application code — it belongs on the suite's EXCLUDED list, not
-- this grant.

grant update (whatsapp_number, telegram_bot_username) on orgs to authenticated;
