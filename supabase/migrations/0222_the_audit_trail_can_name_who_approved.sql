-- The auditor's own audit trail could not name a single person.
-- (Reported after the 28 Aug 2026 demo — decision 23.)
--
-- ⚠️ THE SYMPTOM. On the Approvals queue, signed in as the payment auditor,
-- every completed stage read:
--
--     1. Audit review and approval
--        Approved by someone no longer listed · 28 Aug 2026
--     2. Managing Partner approval
--        Approved by someone no longer listed · 28 Aug 2026
--
-- Nobody had left. `ChainTrail` renders `actorName ?? "someone no longer
-- listed"`, and the name is an embed on `users` — which returned null, because
-- the auditor cannot read it.
--
-- Measured on the live database, counting rows each role may SELECT from
-- `users` in one 112-person organisation:
--
--     payment_audit_approver     1      (their own row, and nothing else)
--     payment_approver           1
--     finance_approver         112
--     executive                112
--     admin                    112
--     facility_manager         112
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- `users_select` gates on `oversight_roles_with_fm()`, written in `0072a`.
-- `payment_audit_approver` and `payment_approver` were created afterwards, by
-- `0151`, and were never added to it.
--
-- 📌 THIS IS `0157` AGAIN, ONE TABLE OVER. That migration's own header says it
-- exactly: *"0151 added payment_audit_approver and payment_approver and gave
-- them authority over those tables without giving them sight of them."* It
-- fixed `payments` and `remittances`. `users` is the third table those roles
-- read through, reached by an EMBED rather than by a query anyone wrote, so it
-- did not show up as an empty screen — it showed up as a wrong sentence, which
-- is harder to notice and worse to leave.
--
-- The board's direction is that the auditor sees every detail of what they are
-- approving. An approval trail that cannot say who approved is not a detail
-- that is merely missing; it is the audit trail failing at its one job, on the
-- screen belonging to the person whose stage exists to check it.
--
-- ── Scope, stated ─────────────────────────────────────────────────────────
--
-- These two roles now read `users` rows in their OWN organisation, exactly as
-- an FM/PM already does — same columns, same org boundary, no cross-org reach
-- (the `org_id = current_user_org_id()` conjunct is untouched and is what
-- enforces B1 here).
--
-- A narrower "names only" view was considered and rejected: it would be a
-- second mechanism for a question `users_select` already answers, and decision
-- 8's rule is one resolver extended rather than a parallel one. The row carries
-- staff contact details, which every operational role in the same organisation
-- can already read.
--
-- ⚠️ Rewritten from the LIVE policy expression (`pg_policies.qual`), not from
-- 0072a's text, per the 0136 lesson. The only change is the added disjunct;
-- `payment_chain_roles()` is `0157`'s existing definition of exactly these two
-- roles, reused rather than restated.

drop policy if exists users_select on users;

create policy users_select on users for select
  using (
    org_id = current_user_org_id()
    and (
      id = auth.uid()
      or current_user_role() = any (oversight_roles_with_fm())
      -- NEW. The two chain roles, so an approval can be attributed to a person
      -- on the screen where it is being decided.
      or current_user_role() = any (payment_chain_roles())
    )
  );

comment on policy users_select on users is
  'Everyone reads their own row; oversight, FM/PM and — since 0222 — the two payment-chain roles read every row in their OWN organisation. The chain roles are here because the approval trail names its actors through an embed on this table, and without it every stage rendered "Approved by someone no longer listed" to the auditor whose stage exists to check it. Same omission 0157 fixed for payments and remittances, one table over.';
