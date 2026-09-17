-- A read-only observer role.
--
-- The need: showing build progress to someone outside the organisation — a
-- reviewer, an auditor's assistant, a prospective client's technical contact —
-- without handing them an operational account. Every existing role was wrong for
-- it: `finance_approver` is the only one that sees org-wide, and it sees the
-- entire client-funds ledger and bank configuration.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- and the migration runner wraps each file in one. Hence the split: this file
-- adds the value, 0038 uses it.

alter type user_role add value if not exists 'viewer';
