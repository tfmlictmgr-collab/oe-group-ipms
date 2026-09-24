# v1.0.0-rc5 — the tag annotation

**To be cut at the merge commit of the privacy-notice PR on `main`.**

`rc4` died twice: PR #56 put the legal pages inside `next build`, and PR #57
changed `lib/gateway/index.ts`. Neither could ride a tag cut before them.

## What was run, and where

- **0.3 — `128 of 128 suite(s) passed`**, run on `98cd812` (the merge of PR
  #57). Zero `FAIL`, zero `NET`, 3 `DEMO`. The run of record is
  `docs/verify-runs/rc5-20260924.log`.
- **0.5 — `docs/verify-runs/rc5-audit.json`.**
- **0.2** — re-run on the tagged tree itself, because the privacy-notice delta
  is inside `next build`.

⚠️ **The tag is NOT on the tree 0.3 ran against**, and that is deliberate
rather than overlooked. The privacy notice landed after the suite run. The
delta is four files — `app/legal/privacy/page.tsx`, `app/legal/layout.tsx`,
`components/auth/sign-in-panel.tsx`, `app/tenancy/[org]/ApplicationForm.tsx` —
and it touches no SQL, no migration, no RLS policy and nothing under `lib/`.
**No verify suite reads any of them**, checked rather than assumed: the only
suite that reads anything nearby is `verify-application-lga`, which reads
`lib/application-form.ts`, and that file is untouched — `CONSENT_STATEMENT` was
left byte-identical on purpose, because it is stored verbatim on every
application. So 0.3 carries over and 0.2 is re-run. This is the same reasoning
the `rc3`→`rc4` delta used.

Before tagging, confirm the delta really is only those four files:

```
git diff 98cd812 <merge-commit> --stat -- . ':!docs'
```

A tag push from the build session is refused (HTTP 403), so a person creates it:

```
git fetch origin
git tag -a v1.0.0-rc5 <merge-commit> -F docs/verify-runs/rc5-tag-message.md
git push origin v1.0.0-rc5
```

⚠️ `-F` reads this whole file. Strip everything above the line below first, or
paste the block into `git tag -a` in an editor.

---

The first release candidate that can lawfully hold real personal data

Supersedes v1.0.0-rc4, which never deployed: the legal pages (#56) and the
gateway changes (#57) both landed inside next build after it was cut.

Schema 0300, unchanged. Suites 124 -> 128. Stage 0 fully met: 0.2 on this
tree, 0.3 at 128 of 128 with no NET lines, 0.4 clean, 0.5 recorded.

What changed since rc4, and why it matters:

  Privacy   The privacy notice is PUBLISHED, at /legal/privacy. It had been
            drafted since 19 August and never published, while Terms and a
            Refund Policy went live because a payment processor asked for
            them. The NDPA requires the notice; nothing required it of us,
            so it did not happen. It is reachable from the sign-in door, the
            legal nav, and beside the consent step of the tenancy
            application, which is where identity documents, employment,
            next of kin and income are actually handed over. Its four
            "[to be added before publishing]" contacts are gone:
            DPO_CONTACT_EMAIL is one deployment value, falling back to the
            organisation's own support address marked for the DPO. It never
            renders a blank — a notice telling somebody to contact a bracket
            is a right they cannot exercise.

  Gateway   The collections banner reads the ORGANISATION's gateway, not the
            platform's. gatewayMode() and collectionGatewayName() read
            process.env alone, while the checkout beside them has run on the
            org's own credential since 0288. While both were Paystack the two
            could only disagree about test-vs-live; once Flutterwave became
            the preferred Naira collector they could disagree about which
            gateway, and an org on its own live key could be told no card
            would be charged. collectionRouteForOrg answers the banner's
            question the way resolveOrgGateway answers the checkout's, and
            the screen gained the two states it never had: "no account
            connected", which after 0288 is every org but one, and "could not
            be read", which declines to guess.

  Payouts   A payout in a currency no gateway serves is refused in every
            world, not simulated in the keyless ones. A foreign-currency
            payout used to fall through to the simulated adapter, whose
            transfer reports success and posts to the ledger — so a staging
            rehearsal would have watched it succeed and proved a path that
            refuses in production.

  Evidence  rc3's run of record and audit snapshot are in the repository at
            last. They had sat on one workstation for three days while the
            build plan cited them. A run of record belongs in the same commit
            as the claim it backs.

Known and accepted at this tag:

  - No payment gateway key in production. Collections are unavailable and
    payouts go by recorded bank transfer (0289) through the same approval
    gate. This is the designed behaviour, not a degradation, and it is where
    Flutterwave's account reactivation leaves us.
  - The privacy notice is published but not yet legally reviewed. The
    wording can improve; the absence could not.
  - Thirteen processor DPAs are unsigned. The NDPA addendum is drafted and
    with counsel. Most processors' own GDPR-based DPAs already bind;
    Telegram, 360dialog and Africa's Talking have none confirmed.
  - NDPC registration is unresolved.
  - No external penetration test has been run.
