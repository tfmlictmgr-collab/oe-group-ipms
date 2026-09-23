# v1.0.0-rc4 — the tag annotation

**To be cut at the merge commit of PR #53 on `main`.** Stage 0 was run on
`fe319be` (the PR head, already merged with `main` at `4af81db`), so the
merge commit carries exactly the tree that was verified, provided nothing else
lands on `main` first. If something does, rule 7 applies: re-run the gates on
the new tree before tagging.

📌 PR #54 (`docs/BACKUP_AND_RESTORE.md` only) was merged into the branch after
the run. `git diff fe319be <tag> -- . ':!docs'` is empty, so no byte outside `docs/`
differs from the verified tree. Check that the same command is still empty
against the actual merge commit before tagging.

A tag push from the build session is refused (HTTP 403), so a person creates it:

```
git fetch origin
git tag -a v1.0.0-rc4 <merge-commit-of-#53> -F docs/verify-runs/rc4-tag-message.md
git push origin v1.0.0-rc4
```

⚠️ `-F` reads this whole file, headings and all. Strip everything above the
line below first, or paste the block into `git tag -a` in an editor.

---

Flutterwave takes Naira collections; payouts never reach it

Supersedes v1.0.0-rc3, which died with PR #37 (app/layout.tsx is in the
bundle) and again with this change (rule 7).

Schema 0300 (+0213a, already applied to production). Suites 124 -> 128.

What changed since rc3, and why it matters:

  Gateway  Flutterwave replaces Paystack for collections (board Option A,
           23 Sept 2026). Paystack's verification asks cannot be met in time.
           gatewayPreference() is the one place the choice is made: NGN is
           collected on Flutterwave first and Paystack second, and payouts go
           to Paystack only. With no Paystack account, a payout is refused
           before the claim and is paid by recorded bank transfer (0289).
           Settlement refuses a currency mismatch. The webhook verifies with
           the sender's own credential. Settings -> Banking requires
           Flutterwave's secret hash.
  Guards   Verify suites refuse production by allow-list, not /prod/i (#52).
           The production URL never contained "prod".
  Cutover  Stage 3 proof, bootstrap sign-in link, Supabase Auth URLs, the
           oe-group sender, slugs before invitations, storage backup
           (#38-#51).

Stage 0 on fe319be, 23 Sept 2026:
  0.2  tsc --noEmit clean; next lint clean; next build 81/81 pages;
       CI "types, lint, build" green on PR #53
  0.3  npm run verify against dev: 125 PASS, 2 DEMO, and two that need a dev
       server (verify-people-directory, verify-checkout-e2e), both then
       PASSING standalone against one on the same tree and world. 128 of
       128 green.
  0.4  gitleaks: no leaks, full history; .gitleaksignore still the same 4
  0.5  npm audit: 32 findings (1 critical, 10 high, 21 moderate), unchanged
       from rc3; the critical remains the non-applicable one (1c)

Not yet exercised: a real Flutterwave checkout. No Flutterwave test key
exists on any world yet; the Stage 4 rehearsal is where it happens.
