-- 0148 reintroduced exactly the bug 0114 already fixed and left a comment
-- warning about.
--
-- ⚠️ Found running `scripts/verify-channel-consent.mjs` and
-- `scripts/verify-function-grants.mjs` after 0148 landed: `anon` — the
-- unauthenticated key shipped in every page bundle — could call
-- `has_channel_consent`, `my_channel_consents`, `record_my_channel_consent`
-- and `withdraw_my_channel_consent`. All four use 0148's own idiom:
--
--     revoke all on function f(...) from public;
--
-- which is precisely the idiom 0114's own comment names as the cause of "101
-- of 103 SECURITY DEFINER functions were callable by anon": `PUBLIC` is the
-- pseudo-role meaning "everyone by default"; Supabase's default privileges
-- write EXPLICIT grants to `anon` and `authenticated` at object-creation
-- time, and revoking from `PUBLIC` does not touch an explicit grant already
-- held by a named role. 0148 was written after 0114 existed and used the old
-- idiom anyway.
--
-- **Confirmed exploitable, not theoretical**, same standard 0114 set: using
-- only the anon key, `has_channel_consent(p_user_id, 'whatsapp', ...)`
-- answers "is this arbitrary person contactable on WhatsApp" for anyone who
-- can guess or enumerate a user id — precisely the probe 0148's own comment
-- says the withheld grant exists to prevent: "Granting it would let any
-- signed-in person probe whether any other person is contactable." It did
-- not even require being signed in.
--
-- `verify-function-grants.mjs` (0114's regression guard) only partially
-- caught this: it flagged the three functions that appear in a
-- `grant execute ... to` statement elsewhere (so it knows authenticated was
-- the intended ceiling), but `has_channel_consent` is declared nowhere as
-- granted to anyone — service_role's access is implicit, never an explicit
-- grant line — so the scanner's "no declared intent → skip" rule (by design,
-- for extension internals and triggers) silently skipped the one function
-- with the widest blast radius. That gap in the scanner is real and is
-- flagged separately; this migration fixes the grants, not the scanner.
--
-- The corrected idiom, matching every revoke in 0114 itself: name the role.
revoke execute on function has_channel_consent(uuid, text, text) from anon, authenticated;
revoke execute on function my_channel_consents() from anon;
revoke execute on function record_my_channel_consent(text, text, text) from anon;
revoke execute on function withdraw_my_channel_consent(text) from anon;

-- Re-assert the three end-user functions still work for the role that must
-- keep them — a revoke migration that silently also removed the grant this
-- feature depends on would trade one hole for an outage.
grant execute on function my_channel_consents() to authenticated;
grant execute on function record_my_channel_consent(text, text, text) to authenticated;
grant execute on function withdraw_my_channel_consent(text) to authenticated;

comment on function has_channel_consent(uuid, text, text) is
  'Answers whether an arbitrary user has live consent for a channel. Service-role only, by design — not granted to anon or authenticated (0154; 0148 tried to say this with "revoke all ... from public", which does not reach an explicit anon/authenticated grant made by Supabase''s default privileges, per 0114). Calling this from anywhere reachable by a signed-in or anonymous session lets a caller probe a stranger''s contactability.';
