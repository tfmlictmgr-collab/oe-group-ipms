# Stage 5.10 — production read-back and per-host legal pages, 25 Sept 2026

Target: **production** (`civwriqvghvyqtfrzftu`), serving `v1.0.0-rc6`
(`b38d166`; `main` at `fee97b9` adds docs only). Queries:
`docs/sql/stage5-readback.sql`. Pasted from the SQL editor and the operator's
terminal.

> ⚠️ A first attempt ran the queries in a **non-production** editor (dev or
> staging): ~100 `PROBE…` orgs, routes dated 19–20 Aug — before the production
> project existed (21 Sept) — and ₦542,825,927 on OEA's ledger. Discarded. Check
> the project ref in the address bar before reading any result.

## Step 3 — the read-back

### Query 1 — orgs

| slug | domain | sender | support | verdict (first rule) | verdict (rule as committed) |
|---|---|---|---|---|---|
| `oe-group` (operator) | portal.tfmlconsultant.com | TENTai `no-reply@notify.tfmlconsultant.com` | — | STOP: no support | **CHECK**: no support address |
| `oea` | oeaportal.com | OEA `no-reply@notify.oraegbunike.com` | info@ / finance@oraegbunike.com | OK | **OK** |
| `sc-client` | — | — | — | STOP: no domain | **STOP: no sender** — see below |
| `tfml` | tfmlportal.com | TFML `no-reply@notify.tfmlconsultant.com` | it@ / accounts@tfmlconsultant.com | STOP: shared (B1) | **OK** |

- **TFML's "shared" flag was the operator, not OEA.** TFML and the OE Group
  operator send from the same address. Not B1: operator mail reaches only its
  own staff (`sendEmail` takes the SENDING org's identity; `createOrg` invites a
  new org's admin as that org, lease notices go as the lease's org). The query
  now compares client orgs only (`603b0a0`), and a planted client org sharing
  OEA's sender still reads STOP.
- **`sc-client`** is the placeholder for the not-yet-named service-charge
  client (`0094`: TFML manages, OEA administers). **Dormant in this window.**
  No page or function reads it or `org_brand_associations`, so TFML's and OEA's
  own service-charge modules are unaffected. With no sender, the app sends it
  no mail at all (`lib/email.ts` declines rather than borrow a brand). Rename,
  set a sender, then invite — when the client signs. Do not delete it:
  `bootstrap-production` expects it.
- **`oe-group`** has no support address. Not a blocker: `DPO_CONTACT_EMAIL` is
  set, so the privacy notice never falls back to it. Set one when convenient.
- `www` is not a gap: `org_branding_by_host` (`0179`) matches a bound domain
  with or without `www.`.

### Query 2 — channels

| slug | channel | label | registered | can send | secret | verdict |
|---|---|---|---|---|---|---|
| oea | telegram | @oea_properties_bot | 2026-09-24 | yes | 48 | **OK** |
| tfml | telegram | @tfml_support_bot | 2026-09-24 | yes | 48 | **OK** |

No WhatsApp rows — correct until 5.5. **Closes 5.6.**

### Query 3 — client-funds accounts

| slug | account | currency | linked | shown to payers | opening | ledger | verdict |
|---|---|---|---|---|---|---|---|
| oea | Client funds account | NGN | yes | yes | — | 0 | **OK** |
| tfml | Client funds account | NGN | yes | yes | — | 0 | **OK** |

One live account per org, ledger at zero, no opening entry — the correct state
for new, empty accounts. **Closes 1.9** (file each bank statement at ₦0.00
before the first real payment).

## Step 4 — each host names only itself

`curl -sSL https://<host>/legal/<page> | grep -oE "Total Facilities Management|Ora Egbunike|TFML|OEA" | sort | uniq -c`

| host | terms | refunds | privacy |
|---|---|---|---|
| www.tfmlportal.com | 15 Total Facilities Management | 7 Total Facilities Management | 9 Total Facilities Management |
| oeaportal.com | 15 OEA · 15 Ora Egbunike | 7 OEA · 7 Ora Egbunike | 9 OEA · 9 Ora Egbunike |

Zero cross-brand hits on six pages. The privacy notice — which named both
brands on rc5 — names only its own on rc6.
