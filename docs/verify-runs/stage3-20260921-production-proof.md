# Stage 3.4 / 3.6 — production proof, 21 September 2026

Project `civwriqvghvyqtfrzftu` (`TENTai-production`, eu-west-1), schema `0300`.
Queries: `docs/sql/stage3-production-proof.sql`, run in the production SQL
editor. 3.6 asks for the query **and its output**; the query is that file and
the output is this one.

---

## 3.4 — the seven buckets: **PASS**

All seven present, every `verdict` reading `OK`.

| bucket | public | limit | mime types |
|---|---|---|---|
| `org-logos` | **true** (by design) | none | 0 |
| `application-documents` | false | 10 485 760 (10 MiB) | 4 |
| `work-order-media` | false | 26 214 400 (25 MiB) | 7 |
| `vendor-documents` | false | 2 097 152 (2 MiB) | 4 |
| `invoice-attachments` | false | 2 097 152 (2 MiB) | 5 |
| `payment-proofs` | false | 5 242 880 (5 MiB) | 6 |
| `payout-evidence` | false | 5 242 880 (5 MiB) | 6 |

`org-logos` is the one public bucket and is meant to be: it holds the brand
marks painted on sign-in pages. Its null limit and zero MIME types are
expected — the query exempts it from the allow-list check for that reason.
Every bucket holding a person's documents is private, capped, and MIME-limited.
`application-documents` carries `0300`'s 10 MiB cap, and `vendor-documents`
carries `0213`'s lowered 2 MiB rather than `0164`'s original 15 MiB.

## Migration ledger: **321 applied, highest `0300`**

321 is exactly the number of `.sql` files in `supabase/migrations` — 320 plus
`0213a`. The ledger and the directory agree, which is the check; "the
migration finished" and "every file ran" are different claims and only the
second one matters.

## 3.6 — emptiness: **PASS**

**Every table that holds a person, a sum of money, or a piece of work is
zero.** `users`, `tenant_applications`, `leases`, `tickets`, `payments`,
`vendors`, `invitations`, `notifications`, `ledger_entries`,
`ledger_postings`, `payment_intents`, `offline_payment_claims`,
`rent_charges`, `service_charges`, `properties`, `units`, `bank_accounts`,
`channel_consents` — 0 rows, all of them. No personal data has reached
production, which is the claim the 13 DPAs depend on.

The non-zero tables, each accounted for:

| table | rows | why |
|---|---|---|
| `role_permissions` | 780 | the B7 permission baseline. 780 = 20 × 39 capabilities, a per-org baseline across two orgs |
| `_migrations` | 321 | the ledger itself |
| `audit_log` | 87 | written by `log_audit` triggers as the migrations created the rows below — no human action |
| `org_nodes` | 59 | the two org trees (`0097` gives every org one) |
| `capabilities` | 39 | the capability catalogue |
| `nigeria_states` | 37 | reference data — 36 states plus the FCT, exactly right |
| `property_types` | 29 | reference data (`0237`) |
| `unit_types` | 27 | reference data |
| `vendor_document_requirements` | 15 | reference data (`0164`) |
| `application_document_requirements` | 12 | reference data (`0206`) |
| `org_modules` | 4 | module declarations for two orgs (`0192`) |
| `ledger_accounts` | 2 | the default chart of accounts |
| `org_brand_associations` | 2 | `sc-client` associated to **both** brands — the arrangement `0094` exists for |
| `orgs` | 2 | see below |

### ⚠️ `orgs = 2` is correct, and the reason is worth stating

The build plan's exit gate names "the operator org (`0088`)" alone, which
reads as though a second org were a leftover. It is not. `0208`'s header is
explicit that **two** orgs must exist in any world:

* `oe-group` — the platform operator (`0088`). The control plane, holding
  `is_platform_operator` and with it decision 7's single deliberate crossing
  of org isolation.
* `sc-client` — the service-charge client (`0094`). "The organisation the
  entire brief is about: the entity whose vendors OE Group pays on its behalf,
  and the only org carrying `org_brand_associations` to both brands."

`0208` exists *because* a seed once truncated them and nine checks in
`verify-sc-client` stopped at "the service-charge client org exists". So two
orgs with zero users is the correct shape of an empty production database,
not a finding.

## The privilege audit — **no new findings**

Full classification is recorded beside the query in
`docs/sql/stage3-production-proof.sql`. The headline is an absence:
`conversation_state`, `sender_open_requests`, `resolve_ticket_by_ref` and
`remember_conversation_state` do **not** appear. `0213a` is verified against
the live database, not only against the local PostgreSQL 16 reproduction it
was developed on.

One row remains unexplained rather than waved through: **`rls_auto_enable`**
exists in production and appears nowhere in this repository — no migration,
no script creates it. Presumed Supabase platform furniture. To settle it, run
the same query against dev: a function present in both that no migration
creates came from the platform.

---

## Verdict

**3.4 PASS. 3.6 PASS.** Stage 3's exit gate reads "schema at `0300`, seven
buckets correct, every variable set, the emptiness query committed with its
output" — three of four met by this file. **3.5 (environment variables and the
redeploy) is what remains.**
