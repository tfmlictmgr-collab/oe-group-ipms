# Project Handoff / Current State

> **Read this first** when picking the project up on a new machine or in a new
> session. It is the fast catch-up; CLAUDE.md is the master brief; the rest of
> `docs/` and the git log are the detail.

## What this is
OE Group's AI-powered Integrated FM/Property Management System (IWMS) — a
WhatsApp-first, cloud-native platform unifying TFML (facilities) and OEA
(property) on one backend with strict per-brand data isolation.

## Where everything lives (all cloud — nothing critical on any laptop)
- **Code:** GitHub `tfmlictmgr-collab/oe-group-ipms` (branch `main`)
- **Database:** Supabase (cloud Postgres) — URL `egqzjrmzxqqxrrqpdwbt.supabase.co`
- **Hosting:** Vercel — live at `https://oe-group-ipms.vercel.app`
- **Secrets:** `.env.local` only (git-ignored) — the one file to carry between
  machines. Contains Supabase keys, Anthropic key, WhatsApp token + phone id,
  Telegram token, DEMO_ORG_ID.

## Current state (POC complete)
All six AURA modules built, verified, and deployed:
1. Resident/Tenant Portal · 2. Vendor Management · 3. Service Charge Admin ·
4. Gated Vendor Payments (simulated) · 5. Immutable Audit · 6. Role-scoped BI.
Plus: dual-brand instantiated & isolated, dispatch/assignment, B8 notification
cascade, classifier accuracy (category 100%), property-scoped RBAC for FM/owner,
one-command demo seed (`npm run seed`), QA script, and a board demo narrative.

The 21-day POC workflow is complete through demo prep. Against the 6-week board
milestone plan, Weeks 0–5 deliverables are done (see `RECONCILED_ROADMAP.md`).

## The 9 demo logins (all password `OEGroupDemo2026!`)
`demo@` admin · `finance@` Oke Anderson · `fm@` Abdul Owo · `ops@` Emeka Ade ·
`owner@` Bola Adeyemi · `vendor@` Sparkle · `resident@` Tamuno Gab ·
`tfml@` (navy brand) · `oea@` (red brand). All `@oegroup.test`.

## WhatsApp status
Live on the real number **+234 708 471 4148** (Phone Number ID
`1213024785231544`); inbound→AI→ticket→reply round-trip confirmed. Business
Verification is optional/in-progress (only unlocks the org display name + higher
limits) — see `BUSINESS_VERIFICATION.md`. Does not block anything.

## Key documents (index)
- `CLAUDE.md` — master build brief (auto-loaded)
- `RECONCILED_ROADMAP.md` — merged board+daily plan, status, tracked Phase-1 gaps
- `OE_Group_Phase1_Production_Roadmap.docx` — the 14-day Phase 1 build plan
- `DEV_SETUP.md` — set up on a new machine + work across two machines
- `WEEK2_CHECKPOINT.md` — access-matrix pass + module state
- `QA_SCRIPT.md` — end-to-end demo runbook
- `DEMO_NARRATIVE.md` — spoken board-demo script + screenshot shot-list
- `BUSINESS_VERIFICATION.md` — Meta verification checklist
- `PHASE1_VENDOR_EVALUATION.md` — KPI/SLA dual-source vendor scoring spec

## Next up: Phase 1 (start safely — do NOT touch the live POC)
Plan: build Phase 1 in parallel on a `phase-1` branch against a **separate**
Supabase dev project, so `main` + the live demo stay untouched.
1. New machine: clone, `npm install`, copy `.env.local` (see `DEV_SETUP.md`).
2. Create a new Supabase project `oe-group-dev` (separate from the POC DB).
3. `git checkout -b phase-1`; point `.env.local` at the dev DB; `npm run migrate` + `npm run seed`.
4. Build Phase 1 per the roadmap docx; deploy to a Vercel **preview**, not prod.
5. Merge `phase-1` → `main` only when tested.

## ⚠️ Gotcha to remember
Local dev and production currently **share one Supabase DB**, so `npm run seed`
(which truncates) affects live data. Phase 1 Day 1 splits environments and
removes this risk. Until then, run `seed` only when you intend to reset the demo.
