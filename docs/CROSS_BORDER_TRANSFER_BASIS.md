# Cross-border transfer basis — OE Group IPMS

**Status:** working document. Approved by Joseph Emmanuel (ICT) 2026-09-20 to
serve as the working basis pending review by the DPO (**Ebube Ikechwu**) and
Legal. **Board confirmed 2026-09-20: production stays on Supabase**, with Legal
pursuing the NDPC approvals in parallel. Legal has confirmed the transfer
clauses can be approved and filed, so that work proceeds alongside the build
rather than gating it. It is not legal advice; it is the record NDPA s.41 requires a controller
to keep, written so that review has something concrete to correct.

**Closes:** `NDPA_COMPLIANCE_PACK.md` §10 and §11 row 5 (hosting region and
transfer basis). **Gates:** `GO_LIVE_BUILD_PLAN.md` step 1.7 → Stage 3.

---

## 1. The rule we are answering to

**NDPA 2023 s.41** forbids transferring personal data out of Nigeria unless the
recipient is subject to *a law, binding corporate rules, contractual clauses, a
code of conduct, or a certification mechanism* affording an adequate level of
protection — or one of the **s.43** conditions applies (informed consent,
necessity for a contract with the data subject, the data subject's sole
benefit, public interest, legal claims, vital interests).

The same section requires the controller to **record the basis for each
transfer**. That is what this file is.

**s.42** defines adequacy as protection substantially similar to the Act's, and
lets the NDPC take account of adequacy decisions made by comparable authorities
elsewhere.

**GAID 2025** — `NDPC/NDP ACT-GAID/01/2025`, issued 20 March 2025, **in force 19
September 2025** — is the operative directive. Article 45 and Schedule 5 set the
transfer conditions and the adequacy criteria.

---

## 2. ⚠️ The assumption to discard first

> *"Our data sits in Ireland, Ireland is in the EEA, the EEA is on Nigeria's
> whitelist, therefore we are covered."*

**That reasoning no longer holds.** GAID 2025 repealed the NDPR 2019, and with
it the old whitelist that named the EEA, the UK, Canada, Switzerland and others
as adequate. The whitelist has no legal effect.

**And the NDPC has not yet issued an adequacy decision for any country.** So
there is, at present, *no adequacy route available to us at all* — not for
Ireland, not for anywhere.

📌 This is the single most important line in this document. Choosing an EU
region is sound engineering and sound optics. **It is not, by itself, a lawful
basis for transfer.** Anyone who stops at "we host in the EU" has not answered
the question.

---

## 3. Where the data will actually sit

Recorded here because the region is fixed at project creation and cannot be
edited later:

| Service | Production region | Jurisdiction |
|---|---|---|
| Supabase (database, auth, storage) | `eu-west-1` | Ireland |
| Vercel (hosting, serverless functions) | `dub1` | Dublin, Ireland |

Chosen 2026-09-20. Both are Ireland, so the primary store and the compute that
reads it sit under one legal regime rather than two — which keeps the analysis
below to a single conversation per processor instead of two.

⚠️ Dev runs on `eu-west-2` (London). That was a convenience choice and is **not**
the production answer. Do not let it propagate.

---

## 4. The basis we rely on, per processor

Since adequacy is unavailable, **every transfer here rests on contractual
clauses under s.41** — which means the transfer basis and the thirteen unsigned
DPAs (`DPA_TEMPLATE_AND_TRACKER.md`) are **one piece of work, not two**. Each DPA
must carry transfer clauses; a DPA without them does not discharge s.41.

| # | Processor | Purpose | Basis relied on | Must be pinned down in the DPA |
|---|---|---|---|---|
| 1 | Supabase | database, auth, storage | Contractual clauses | Region locked to `eu-west-1`; sub-processor list; no support access without a ticket |
| 2 | Vercel | hosting | Contractual clauses | Function region `dub1`; log retention and where logs live |
| 3 | Anthropic | request triage, document-check findings | Contractual clauses | **No training on our data**; retention window; processing location |
| 4 | Google (Gemini) | classifier failover | Contractual clauses | Same three, and whether the failover path can be disabled per org |
| 5 | 360dialog | WhatsApp | Contractual clauses | Hosting location; message retention |
| 6 | Telegram | optional vendor channel | Contractual clauses | **Confirm a DPA is even offered.** If not, this channel does not go live |
| 7 | Paystack | collections, transfers | Confirm — may not be a transfer | Nigerian-incorporated, but confirm where data is *hosted* |
| 8 | Flutterwave | FX collections | Confirm — may not be a transfer | As above; only if FX is in scope |
| 9 | Resend | email | Contractual clauses | Region; how long message bodies are held |
| 10 | Africa's Talking | SMS fallback | Contractual clauses | Only if enabled |
| 11 | Upstash | rate limiting | Contractual clauses | Region; what a user id is joined to |
| 12 | Sentry | error tracking | Contractual clauses | **EU region**; PII scrubbing settings as configured |
| 13 | Anthropic *(Claude Code)* | engineering tooling | Not a production data flow | Confirm it never touches production data. It has not. |

⚠️ §10 of the compliance pack names five processors as processing outside
Nigeria. That count is wrong — it is closer to eleven. Rows 7 and 8 are the only
plausible exceptions, and only if their hosting is Nigerian, which nobody has
checked.

📌 Rows 7, 8 and 13 are the ones to settle first, because each may *remove* an
obligation rather than add one. Cheaper to answer than to assume.

---

## 5. What we are not relying on, and why

- **Consent (s.43).** Available, and wrong for this. A tenant cannot meaningfully
  refuse the database their tenancy lives in, so consent would be neither freely
  given nor withdrawable. Using it here would make the record less honest, not
  more compliant.
- **Contract necessity (s.43).** Genuinely arguable for Supabase and Paystack —
  you cannot perform a tenancy or take a rent payment without them. But it does
  not stretch to Sentry or Upstash, and a basis that covers two of thirteen is
  not a framework. Contractual clauses cover all of them uniformly.
- **Adequacy (s.42).** Unavailable today. **Revisit when the NDPC issues its
  first decisions** — if Ireland is covered, several rows above get simpler.

---

## 5b. Hosting alternatives considered, and why we stayed

Asked 2026-09-20: could the database move to a Nigerian provider — `pxxl.app`,
`hostafrica.ng` — and remove the transfer altogether?

⚠️ **First, a framing error worth naming.** Supabase is not storage. Measured
in this repository:

| | |
|---|---|
| RLS policies | **157** |
| `auth.uid()` references in migrations | **639** |
| Migrations touching storage | 15 |
| PostgREST embeds the application issues | 38 |
| Suites covering all of it | 120 |

`auth.uid()` is Supabase Auth. Those 157 policies **are** the security model —
the thing that decides whether one tenant sees another's rent, not a layer on
top of it. On a plain Postgres host `auth.uid()` resolves to nothing and every
policy has to be rewritten. That is a rebuild of authorisation on a money
system, not a migration.

**And Supabase has no African region.** `af-south-1` existed during alpha and is
not offered for new projects. Managed Supabase hosted in Nigeria is not
available at any price.

| Option | Migration cost | Transfer position | Ongoing burden |
|---|---|---|---|
| **A. Supabase `eu-west-1`** ✅ chosen | none | contractual clauses (the 13 DPAs) | none |
| B. Self-host Supabase in Nigeria | moderate — open source, Docker, `pg_dump` + GoTrue users | removes the database transfer | **high** — we own backups, PITR, patching, HA, and the service-role key |
| C. pxxl.app / hostafrica.ng Postgres | rebuild 157 policies | **unknown** — neither provider's hosting location was confirmed | high |

On the two providers specifically: **pxxl.app** is a young Nigerian PaaS
(launched publicly late 2025, free tier) — genuinely promising, and without a
track record under a money path. Critically, **if it runs on infrastructure in
Europe then it is still a cross-border transfer** and buys nothing legally.
**hostafrica.ng** is managed cPanel/DirectAdmin VPS hosting — good at what it
does, and not a managed Postgres or Supabase equivalent.

📌 **Decision (board, 2026-09-20): stay on Supabase.** Option B trades a
paperwork problem already being solved for a 24-hour operational one on the
money path, carried by a single ICT manager. Revisit only if the contractual
route becomes unavailable.

**Vercel is not required** — Next.js self-hosts via `next start` or Docker —
but dropping it buys almost nothing here. Vercel holds data in transit and in
logs, not at rest.

---

## 6. Open questions for Legal

Honest gaps. Each is a question, not a position.

1. **Does the NDPC require approval or filing of our contractual clauses?**
   Commentary is split: some reads of GAID require the Commission's approval for
   a transfer instrument, others treat SCCs as immediately usable. **If approval
   is required, it has lead time and it gates Stage 3.** This is the highest-value
   question on the page.
2. **Is there an NDPC-prescribed form of clauses**, or do we draft our own
   against Schedule 5?
3. **Are EU SCCs acceptable as the contractual instrument**, given most of these
   processors already offer them off the shelf?
4. **Does NDPC registration apply to us** as a data controller of major
   importance? (`NDPA_COMPLIANCE_PACK.md` §11 row 9.)
5. **Rows 7 and 8** — are Paystack and Flutterwave hosting in Nigeria? If yes,
   they leave this document entirely.

---

## 7. What happens next

| # | Action | Owner |
|---|---|---|
| 1 | Review and correct this document | DPO |
| 2 | Answer §6.1 — approval/filing requirement | Legal |
| 3 | Ensure all 13 DPAs carry transfer clauses, not just processing terms | Legal |
| 4 | Confirm hosting for Paystack, Flutterwave, Telegram, Sentry, Upstash | ICT |
| 5 | Provision production in `eu-west-1` / `dub1` — **only after 1–3** | ICT |
| 6 | Re-read when the NDPC issues its first adequacy decisions | DPO |

---

## Sources

- [Nigeria Data Protection Act 2023 (full text, PDF)](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf)
- [NDP Act GAID 2025 (NDPC, PDF)](https://ndpc.gov.ng/wp-content/uploads/2025/07/NDP-ACT-GAID-2025-MARCH-20TH.pdf)
- [GAID enters into force, 19 Sept 2025 — Digital Policy Alert](https://digitalpolicyalert.org/event/33614-data-protection-commissions-general-application-and-implementation-directive-including-cross-border-data-transfer-regulation-ndpcndp-act-gaid012025-enters-into-force)
- [Cross-border transfers under the NDPA — Omaplex](https://omaplex.com.ng/cross-border-data-transfers-under-the-nigeria-data-protection-act-2023-legal-challenges-and-regulatory-compliance-in-nigeria/)
- [Reassessing the adequacy of the Whitelist — TechHive Advisory](https://www.techhiveadvisory.africa/insights/changing-trend-in-international-data-transfer-in-nigeria-reassessing-the-adequacy-of-the-whitelist-and-the-implications-for-businesses)
- [GAID 2025 compliance guidelines — Lawyard](https://www.lawyard.org/blog-articles/gaid-2025-key-data-protection-compliance-obligations-for-nigerian-businesses-by-daniel-ibikunle/)
- [Cross-border transfer compliance — EuroCloud](https://eurocloud.org/news/article/cross-border-data-transfer-navigating-compliance-under-the-nigerian-data-protection-act-2023/)

⚠️ Secondary sources were used where the NDPC's own PDF could not be retrieved
from this environment. **Legal should verify Article 45 and Schedule 5 against
the primary text** before this leaves working-document status.
