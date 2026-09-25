# Legal review pack — OE Group IPMS

> **Update, 25 September 2026 — two corrections to read this pack by.**
> 1. **The data controller is a TENTai entity**, not OE Group. Wherever this
>    pack names OE Group as controller or as the party signing, read TENTai.
>    Please confirm the entity's exact registered name for the notice and the
>    DPAs.
> 2. **There are now fourteen processors, not thirteen.** Cloudflare was added
>    when its Turnstile bot check went live on every sign-in, invitation,
>    password reset and vendor application. It receives visitors' IP addresses
>    and browser signals.


**Prepared:** 24 September 2026 · **Prepared by:** J. Amapakabo, ICT Manager

This pack accompanies the OE Group integrated facilities and property
management platform, which serves two brands — **TFML (Total Facilities
Management Limited)** and **OEA (Ora Egbunike & Associates)** — from one
system, with each organisation's data kept separate.

It is sent for review ahead of production go-live. **Nothing in it has been
reviewed by a lawyer yet.** Every document was drafted in-house against the
system as actually built, not against an intended design.

> **Please note before you begin.** The two public-facing policies (Terms of
> Service, Refund Policy) are *generated from the application's source code*.
> Marking up the Word file does not change the website — any wording you accept
> has to be put back into the software before it takes effect. The same is true
> of the privacy notice once it is published.

---

## 1. What is in this pack

| # | Document | What it is | Status |
|---|---|---|---|
| 1 | Terms of Service | Published at `/legal/terms` on each portal | **Live on the site, unreviewed** |
| 2 | Refund Policy | Published at `/legal/refunds` on each portal | **Live on the site, unreviewed** |
| 3 | Privacy Notice | Drafted 19 Aug 2026; **not yet published** | Draft for review |
| 4 | NDPA Compliance Pack | The umbrella assessment: lawful bases, retention, processors, open items | Working document |
| 5 | Data Subject Rights Procedure | How access, correction, erasure and portability requests are handled | Drafted, partly implemented |
| 6 | Breach Procedure | The 72-hour NDPC notification procedure | Drafted |
| 7 | Processor DPA Template and Tracker | The NDPA addendum, and the 13 processors it must be signed with | Template for approval |
| 8 | Cross-Border Transfer Basis | The s.41 analysis under GAID 2025, and the hosting-region decision | Closed in-house, for confirmation |
| 9 | Consent and Open Items | Channel consent, and the questions nobody has answered yet | Working document |

## 2. Why the two public policies were published first

Flutterwave requires a merchant's website to carry terms of service and a
refund policy before it will reactivate the account. Without that account the
platform cannot collect any money, so the pages were written and published to
unblock it. **They were published on commercial urgency, not on legal advice** —
which is precisely why they are first in this pack.

## 3. What we are asking for

**On the two public policies (1 and 2):**

1. Are they adequate as consumer-facing terms under Nigerian law for a business
   that collects rent, service charges and refundable deposits on behalf of
   third-party property owners?
2. **Terms clause 3** names Paystack and Flutterwave as the payment processors.
   The board is minuting a change that may mean Paystack is never used. Should
   the clause name processors at all, or describe them generically?
3. **Refunds clause 4** commits to fixed service levels — acknowledge in 2
   business days, decide in 10, initiate in 5. Nobody has yet confirmed the
   approval desks can meet these. Is a published commitment of this kind wise?
4. **Terms clause 5** directs data-subject requests to the organisation's
   support inbox rather than to a named Data Protection Officer. See item 5
   below — this needs to agree with whatever the DPO position turns out to be.
5. Are the limitation-of-liability and governing-law clauses (Terms 9 and 11)
   sufficient, and is anything required by law missing?

**On data protection (3 to 9):**

6. **NDPC registration (open).** Does OE Group meet the data-controller
   threshold requiring registration with the Commission, and must the DPO be
   registered? A DPO has been designated internally (Ebube Ikechwu, board,
   19 Aug 2026) but is not registered and their contact details are not
   published.
7. **Special-category data (open, board decision).** The tenancy application
   currently collects religion and marital status. Our own reading is that the
   cleanest NDPA position is not to collect them at all. We would like that
   confirmed or corrected before the form is finalised.
8. **The processor DPA addendum (item 7).** Thirteen processors carry personal
   data. Most publish a GDPR-based DPA; the addendum in item 7 is intended to
   add what the NDPA requires on top. Is it sufficient, and is it something a
   processor will reasonably sign?
9. **Cross-border transfers (item 8).** Production will be hosted in the EU
   (Ireland). GAID 2025 repealed the NDPR 2019, and Nigeria operates no
   adequacy whitelist, so the transfer basis relied on is **contractual clauses
   under s.41**, carried by the 13 DPAs. Please confirm that reasoning, and in
   particular whether the Commission's approval is required — commentary is
   split on that point.
10. **The privacy notice (item 3)** has never been published and needs review,
    the DPO's details filled in, decisions on the bracketed items, and sign-off
    from both TFML and OEA, since one notice serves both brands.

## 4. What is not in this pack

- **Signed DPAs.** None of the thirteen has been signed. Item 7 is the template
  and the tracker, not executed agreements.
- **A NDPC registration certificate.** See item 6 above.
- **A penetration test report.** Commissioned separately, to run against an
  empty production environment before launch.
- **The tenancy, lease and service agreements themselves.** These policies
  govern the *portal*; the underlying agreements are separate documents and are
  expressly stated to prevail over them on money terms.

## 5. Timing

Production infrastructure is provisioned and empty. The gating items for launch
are the signed DPAs, the NDPC position, the board's decision on
special-category data, and the payment-gateway account. **Legal review of this
pack sits on the critical path for the first three.**

An indication of how long a full review will take would help us set the go-live
date, which has not yet been fixed.
