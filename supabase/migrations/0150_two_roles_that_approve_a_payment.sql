-- The two roles the tiered approval chain needs (board direction, Aug 2026).
--
--   `payment_audit_approver` — stage 2. Verifies the invoice against the job
--                              card and the evidence before it reaches anyone
--                              with a spending limit. Distinct from `viewer`,
--                              which reads and decides nothing.
--   `payment_approver`       — stage 3. Final approval, and the only role whose
--                              authority is bounded by an AMOUNT rather than by
--                              a place or a record. Carries `approval_tier`.
--
-- ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds it, and
-- the migration runner wraps each file in one. Hence the split, exactly as 0037
-- did for `viewer` and 0071 for `executive` / `regional_manager`: this file adds
-- the values and 0151 uses them.

alter type user_role add value if not exists 'payment_audit_approver';
alter type user_role add value if not exists 'payment_approver';
