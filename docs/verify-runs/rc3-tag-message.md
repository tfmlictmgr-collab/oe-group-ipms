# v1.0.0-rc3 — the tag annotation

**Cut 21 Sept 2026 at `c628e90`.** Kept here because a tag push from the build
session is refused with HTTP 403 (branch refs are permitted, tag refs are not),
so the tag is created by a person and this is the message to give it:

```
git tag -a v1.0.0-rc3 c628e90 -F docs/verify-runs/rc3-tag-message.md
git push origin v1.0.0-rc3
```

⚠️ `-F` reads this whole file, headings and all. To use it verbatim, strip
everything above the line below first — or just paste the block into
`git tag -a v1.0.0-rc3 c628e90` in an editor.

---

Stage 2 closed: the gaps are shut and the public surfaces hold

Supersedes v1.0.0-rc2, which died the moment 0299 landed (rule 7).

Schema 0296 -> 0300. Suites 121 -> 124.

What changed, and why each mattered:

  0299  the approved-application 6-year retention clock, closing the last
        open row in the compliance pack. It stamps purge_after and adds no
        second deletion path; the renewal chain is walked forward so a
        sitting tenant is never purged.
  0300  application-documents gets the 10 MB cap and type allowlist its own
        form already claimed. The app checked the caller's CLAIM and then
        issued a signed upload URL, so the bucket was the only place it
        could be enforced.

  Backups     PITR declined on record; daily backups with a stated ~24h RPO,
              plus npm run backup -- --encrypt for a verified off-site copy.
  Rate limits remittance ceiling 30 -> 20 per 5 min; the money path already
              failed closed, which is now written where the code is.
  Turnstile   two ways it refused every applicant, both fixed: a
              half-configured deploy now counts as off, and the single-use
              token is reset after a failed submission.
  Honeypot    renamed away from the tokens Chrome's autofill targets, and
              demoted to a logged signal when Turnstile has vouched.
  Nav search  offers only destinations the role can already reach, filtered
              before the query is matched so nothing leaks by omission.

Local gates on this tree: npm ci, tsc --noEmit, next lint (0 errors,
2 pre-existing alt-text warnings), next build (81 pages) - all green.

Still to run against this tag: npm run verify on dev, gitleaks, npm audit.
