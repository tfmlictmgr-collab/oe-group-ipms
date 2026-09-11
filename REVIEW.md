# Code review guidance (OE Group IPMS)

Highest-priority instructions for the code reviewer. Keep reviews converging, not repeating.

## Re-review convergence — do not repeat what's settled
- If this branch/PR has **already been reviewed**, suppress **nits and style-only**
  comments on later passes. Report only **Important** (correctness, security, data-loss,
  money-path, tenant/brand-isolation) findings.
- **Do not re-raise a finding that has already been settled** — i.e. one recorded in
  `docs/BUILD_AUDIT_BASELINE.md` or marked `accepted` / `wontfix` / `fixed` in
  `build-audit/FINDINGS.md` — **unless the code around it has changed** since it was
  settled. Reference the finding ID (e.g. S-1, E-2) instead of restating it.
- Prefer one consolidated comment per issue over repeated line comments.

## Scope
- Review the **diff**, not the whole repo. Judge changed lines and what they directly
  affect; don't audit untouched code unless the change breaks it.
- This is a multi-tenant FM/property system: weight **tenant/brand isolation (RLS),
  the B4 payment gate, ledger integrity, and audit coverage** highest. The money path
  is intentionally DB-enforced — flag any control that lives only in a server action
  and not in the database.

## Severity discipline
- No false positives: give a concrete failure scenario and cite `file:line`; label
  CONFIRMED vs PLAUSIBLE. Rank Critical / High / Medium / Low. Quality over quantity.

## For the local `/code-review` command (stateless — no memory)
`REVIEW.md` is read by the managed/ultra reviewer, not the local command. To avoid
re-scanning already-reviewed code locally, scope to the new range:
`/code-review <last-reviewed-commit>..HEAD`.
