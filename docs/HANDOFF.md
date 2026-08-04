# Project Handoff / Current State

> **Read this first** when picking the project up on a new machine or in a new
> session. It is the fast catch-up; `CLAUDE.md` is the master brief;
> `PHASE1_WORKPLAN.md` is the authoritative day-by-day status;
> `GO_LIVE_CHECKLIST.md` is the cutover plan; the rest of `docs/` and the git
> log are the detail.
>
> **Last verified current:** 2026-08-04. If this is stale when you're reading
> it, `PHASE1_WORKPLAN.md`'s status board and the last few `BUILD_JOURNAL.md`
> entries are more likely to be right than this file — update this section
> when you notice the drift rather than trusting it blindly.

## What this is
OE Group's AI-powered Integrated FM/Property Management System (IWMS) — a
WhatsApp-first, cloud-native platform unifying TFML (facilities) and OEA
(property) on one backend with strict per-brand data isolation, now extended
into full Phase 1 (lettings, ledger, remittance, analytics, permissions).

## Two worlds — do not confuse them

| | Frozen POC demo | **Phase 1 (current work)** |
|---|---|---|
| Branch | `main`, tag `poc-demo-v1` | `phase-1` |
| Database | separate POC Supabase project | `oe-group-dev` Supabase project |
| Deployment | `oe-group-ipms.vercel.app` | `oe-group-ipms-dev.vercel.app`, plus `tfmlportal.com` / `oeaportal.com` (org-specific fronts, live) |
| Logins | the original 9 flat `@oegroup.test` demo accounts | per-org logins, e.g. `oe-group-foundation-poc.admin@oegroup.test`, `oea.admin@oegroup.test`, `tfml.facilitymanager@oegroup.test` — password still `OEGroupDemo2026!` for all of them; see `scripts/seed-org-logins.mjs` for the full roster |
| WhatsApp | native Meta Cloud API, single shared number | **360dialog**, per-org routing — two live numbers (TFML `+234 703 689 1329`, OEA `+234 708 471 4148`); see `WHATSAPP_360DIALOG_MIGRATION.md` |
| Purpose | sales/demo artifact — do not touch | everything currently being built |

Neither `npm run seed` nor a migration run should ever be pointed at the POC
demo's database from a Phase-1 machine. `PHASE1_SETUP.md` has the full
environment-split rationale and setup steps.

**A real production environment does not exist yet.** It is a third, still
unprovisioned world — see `GO_LIVE_CHECKLIST.md`.

## Where to sign in (Phase 1)
- **`/login`** — the OE Group operator front door on the base Vercel domain.
- **`/o/<slug>`** — an organisation's own branded sign-in (also reachable via
  its custom domain: `tfmlportal.com`, `oeaportal.com`). Hand this to that
  org's people; it reveals nothing about any other org.
- **`/orgs`** — the operator launcher: every organisation as a card, visible
  only to a member of the platform-operator org (`oe-group`).

## Roles (9, current)
`admin` · `executive` · `regional_manager` · `facility_manager` (branded
"Properties Manager" on OEA) · `finance_approver` · `property_owner` ·
`fm_ops_staff` · `vendor` · `tenant` · plus `viewer` (read-only external
oversight). Full capability matrix: `CLAUDE.md` B7, editable per-org (except
locked/non-delegable capabilities) at Settings → Permissions.

## Key documents (index)
- `CLAUDE.md` — master build brief (auto-loaded every session)
- `PHASE1_WORKPLAN.md` — the day-by-day plan and status; **the source of truth
  for "what's built"**
- `GO_LIVE_CHECKLIST.md` — production cutover: who does what, env vars,
  role-based user guide plan, rollback
- `BUILD_JOURNAL.md` — append-only record of what was built, why, and what
  went wrong along the way (read the tail for recent context)
- `BUILD_AUDIT_0804.md` (and earlier `BUILD_AUDIT_*`) — dated security/
  correctness audit snapshots with a PC1-response table
- `PHASE1_SETUP.md` — the three-world environment split, one-time setup on a
  new machine
- `WHATSAPP_360DIALOG_MIGRATION.md` — why/how WhatsApp auth changed; read
  before touching `lib/notify.ts`, `lib/webhook-security.ts`, the WhatsApp
  webhook route, or the registration script
- `CUSTOM_DOMAINS.md` — how `tfmlportal.com`/`oeaportal.com` are wired
- `OEA_TENANT_ONBOARDING.md` — tenant application/KYC design
- `PHASE1_VENDOR_EVALUATION.md` — KPI/SLA dual-source vendor scoring spec
- `RECONCILED_ROADMAP.md`, `QA_SCRIPT.md`, `DEMO_NARRATIVE.md`,
  `DEPLOYMENT.md`, `BUSINESS_VERIFICATION.md`, `WEEK2_CHECKPOINT.md` — POC-era,
  dated snapshots describing the frozen demo. Useful history; not current
  state.

## Running it
- `npm run dev` — local dev server
- `npm run migrate` — apply pending Supabase migrations (`.env.local` must
  point at `oe-group-dev`, never the POC project)
- `npm run seed` — synthetic demo data (same caveat)
- `npm run verify` — the full suite (`npm run verify -- <filter>` to run a
  subset); see `scripts/verify-all.mjs` for the runner's own notes on why it
  uses `node --import tsx` rather than the `tsx` shim

## ⚠️ Gotchas to remember
- `.env.local` is the one file to carry between machines (git-ignored) — see
  `DEV_SETUP.md`.
- A script that resolves an org by `delivery_brand` rather than `slug` is
  reading a non-unique key — this has caused a real incident (a live WhatsApp
  API key attached to a leftover probe org). Use `scripts/lib/org-lookup.mjs`
  for any new script that needs to resolve an org by brand.
- A script that writes to a row it looked up with an unfiltered `.select("*")`
  or `.limit(1)` can end up writing an arbitrary org's data onto the wrong org
  — happened once (audit 0804), caught by `audit_log.before_state` and by
  `verify-email-routing` failing loudly on the next run. Read the row you are
  about to write.
