-- 0140's `create or replace function submit_vendor_invoice(..., p_attachment_path
-- text default null)` did not replace the existing three-argument function —
-- it created a SECOND overload alongside it. Postgres only treats CREATE OR
-- REPLACE as replacing a function when the parameter TYPE LIST matches
-- exactly; adding a fourth parameter, even with a default, is a different
-- signature. Caught immediately by verify-work-order-media-evidence: calling
-- the RPC the way the existing app code always has (three arguments, no
-- p_attachment_path) started failing with "Could not choose the best
-- candidate function between" -- PostgREST could no longer tell whether a
-- 3-argument call meant the old function or the new one with its 4th
-- parameter defaulted.
--
-- ⚠️ Worth being explicit about the lesson: appending a DEFAULTed parameter to
-- an existing function is only a safe, callers-unaffected change when done
-- with DROP FUNCTION first (as 0112 already had to learn the hard way for a
-- return-shape change) -- CREATE OR REPLACE alone is not enough whenever the
-- parameter list itself changes, default or not.

drop function if exists submit_vendor_invoice(numeric, text, uuid);

comment on function submit_vendor_invoice(numeric, text, uuid, text) is
  'The only remaining overload. Callable with 2, 3, or 4 positional/named arguments -- p_ticket_id and p_attachment_path both default to null, so every existing call site (three arguments) and the new one (four, 0140) resolve to this single function.';
