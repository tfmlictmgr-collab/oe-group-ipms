-- The audit trail records the chain and the requisition (decision 35, 5 Sept 2026).
--
-- Asked as: "is this what the audit log will actually be like, stating the
-- actual actions that took place by whom, at what time?"
--
-- Measured, the answer was: for most of the platform yes, and for the one thing
-- an auditor opens the page to check, no. `audit_log` has covered ~60 tables
-- through the generic `log_audit()` trigger since 0005 — bank accounts, ledger
-- entries, vendors, users, budgets, settings — and it is genuinely immutable
-- (`prevent_audit_mutation` refuses UPDATE and DELETE) with a real before/after
-- row diff rather than an event label.
--
-- But grepping every migration for `on payment_approvals` returns three
-- triggers, none of which is `log_audit`; and `on ops_requisitions` returns
-- none at all. So:
--
--   • EVERY individual approval decision — stage 1's sign-off, stage 2's audit
--     review, stage 3's final approval, and every refusal at any of them — was
--     recorded ONLY in `payment_approvals` and appeared nowhere on
--     /dashboard/audit. "Who approved this, and when" is the substance of the
--     question, and it was the part missing.
--   • An ops requisition's ENTIRE life — raised, approved, rejected, remitted —
--     left no trace on that page whatsoever.
--
-- Only the payable's own status transitions were audited, which for a vendor
-- payment means the trail jumped from `recommended` straight to `approved` with
-- the two intermediate desks invisible, and for a requisition showed nothing.
--
-- ⚠️ On ISO/TR 41016:2024, which the request names as the standard to keep
-- these records "in tandem with": that document is *Facility management —
-- Overview of available technologies*. It catalogues categories of FM
-- technology; it does not specify what an audit trail must capture, and citing
-- it as the basis for a record-keeping control would be a compliance claim with
-- nothing behind it. The requirement that actually governs documented
-- information — its creation, control, retention, and protection from
-- unauthorised alteration — is ISO 41001 §7.5, and it is what this schema was
-- already built against: append-only, attributable, timestamped, complete.
-- Recorded here so the next reader is not left to assume the citation was
-- checked. Raised with the board separately.
--
-- 📌 RESOLVED, 5 Sept 2026 — the board confirms the intended reference is
-- ISO 41001, and §7.5 is the clause these records answer to. This paragraph was
-- amended after the migration had been applied; only the prose changed, and the
-- migration did nothing about either standard in the first place. Every other
-- reference in the repo (CLAUDE.md decision 34, the build spec) is repointed to
-- match.

-- ── The chain's own decisions ────────────────────────────────────────────────
--
-- INSERT and UPDATE both. The update is not noise: superseding is how a
-- decision is retired when an amount moves (0151) or when a stage is returned
-- to (0250b), and "this approval stopped counting, at this time" is exactly the
-- kind of fact an auditor is entitled to see without reading the table directly.
drop trigger if exists audit_payment_approval_insert on payment_approvals;
create trigger audit_payment_approval_insert
  after insert on payment_approvals
  for each row execute function log_audit('payment_approval.decision');

drop trigger if exists audit_payment_approval_supersede on payment_approvals;
create trigger audit_payment_approval_supersede
  after update on payment_approvals
  for each row
  when (old.superseded_at is null and new.superseded_at is not null)
  execute function log_audit('payment_approval.superseded');

-- ── The requisition's whole life ─────────────────────────────────────────────
--
-- Status-change only on update, matching `audit_payments` exactly rather than
-- inventing a second convention — a requisition's lines are edited before it is
-- raised, and a row per keystroke would bury the four transitions that matter.
drop trigger if exists audit_ops_requisition_insert on ops_requisitions;
create trigger audit_ops_requisition_insert
  after insert on ops_requisitions
  for each row execute function log_audit('ops_requisition.raised');

drop trigger if exists audit_ops_requisition_status on ops_requisitions;
create trigger audit_ops_requisition_status
  after update on ops_requisitions
  for each row
  when (old.status is distinct from new.status)
  execute function log_audit('ops_requisition.status_change');

-- ── Proof ────────────────────────────────────────────────────────────────────
--
-- Asserted here rather than left to a suite, because the failure mode is
-- silence: a missing audit trigger produces no error, no empty screen and no
-- wrong number — just a page that quietly omits the row nobody thought to look
-- for. That is how this gap survived from 0005 to today.
do $$
declare
  v_missing text;
begin
  select string_agg(t.expected, ', ')
    into v_missing
    from (values
      ('payment_approvals', 'audit_payment_approval_insert'),
      ('payment_approvals', 'audit_payment_approval_supersede'),
      ('ops_requisitions',  'audit_ops_requisition_insert'),
      ('ops_requisitions',  'audit_ops_requisition_status')
    ) as t(tbl, expected)
   where not exists (
     select 1 from pg_trigger g
      where g.tgrelid = t.tbl::regclass
        and g.tgname = t.expected
        and not g.tgisinternal
   );
  if v_missing is not null then
    raise exception 'audit triggers did not attach: %', v_missing;
  end if;
end $$;
