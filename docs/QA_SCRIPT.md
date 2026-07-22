# End-to-End QA / Demo Script (Day 18)

A single narrative that exercises all six modules in logical order. Run it
start-to-finish; every step lists the **expected result**. If a step deviates,
note it for Day 19.

**Setup:** `npm run seed` for a clean dataset. App: `https://oe-group-ipms.vercel.app`.
All logins use password **`OEGroupDemo2026!`**:

| Login | Role | Name |
|---|---|---|
| `demo@oegroup.test` | Admin | Demo Admin |
| `finance@oegroup.test` | Finance/Approver | Oke Anderson |
| `fm@oegroup.test` | Facility Manager | Abdul Owo |
| `ops@oegroup.test` | FM Ops Staff | Emeka Ade |
| `owner@oegroup.test` | Property Owner | Bola Adeyemi |
| `vendor@oegroup.test` | Vendor | Sparkle Cleaning |
| `resident@oegroup.test` | Tenant | Tamuno Gab |
| `tfml@oegroup.test` / `oea@oegroup.test` | Brand admins | TFML / OEA |

---

## 1 — Tenant raises a request (Module 1: Resident Portal)
1. Log in as **resident@**. Nav shows only **Requests · Statements** (tenant scope).
2. **Requests** → **+ New Request**. Enter "The kitchen tap in my flat is leaking",
   category *maintenance*, urgency *high*, submit.
   - **Expected:** redirected to Requests; the new request appears at top, "High",
     "Open". (Behind the scenes it is auto-linked to Lekki Gardens — the resident's
     property — so the managing FM will see it.)

## 2 — AI triage (Module 1 intake + classifier)
3. The 20 seeded tickets span every category/urgency, each with an AI-assigned
   category + priority. Open any channel ticket (WhatsApp/Telegram) as admin later
   to see the AI summary as the title.
   - **Evidence:** `docs/classifier-accuracy-report.md` — category **100%**,
     priority **100% within one step** on the held-out sample.
   - *(Live option: message the Telegram bot; a ticket appears in the portal in
     real time and an acknowledgement replies with Ref/Category/Priority.)*

## 3 — FM dispatches to a vendor (Module 2 + dispatch)
4. Log in as **fm@** (Abdul Owo). **Requests** shows ~14 tickets (Lekki + Ikoyi —
   his managed properties only, not Victoria).
5. Open any open ticket → **Dispatch this request** → Vendor = **Sparkle Cleaning
   Services** → **Assign & notify**.
   - **Expected:** "Assigned to: Sparkle Cleaning Services"; status → **assigned**.

## 4 — Vendor acknowledges (dispatch)
6. Log in as **vendor@**. **Requests** shows only the job(s) assigned to Sparkle.
7. Open it → **Acknowledge job**.
   - **Expected:** amber banner clears; status → **acknowledged**; audit attributes
     the acknowledgement to the vendor.

## 5 — Vendor payment gate (Module 4)
8. Log in as **finance@** (Oke Anderson). **Payments** shows 3 rows:
   FixIt (pending verification), SecureGuard (recommended), Sparkle (remitted).
9. Open **SecureGuard** (recommended). Score 85.1 ≥ threshold 70 → **Approve
   payment** → **Execute remittance (SIMULATED)**.
   - **Expected:** all four gate stages green; "SIMULATED — POC ONLY" reference.
10. Open **FixIt** → **Verify service** → **Run performance check**.
    - **Expected:** score 53.0 < 70 → **Rejected**, "Blocked — vendor failed the
      performance gate. No remittance possible." (Proves the gate both ways.)

## 6 — Service-charge statement (Module 3)
11. Log in as **resident@** → **Statements**.
    - **Expected:** their apportioned charge(s) for Lekki Gardens · Block A - Unit 1
      across the 2025 and 2026 cycles — their unit only, with share %.
12. *(Admin view: as admin@ → Service Charges → a budget → the apportionment table
    reconciles exactly to the budget total; Generate invoices is admin/finance only.)*

## 7 — BI dashboard, role-scoped (Module 6)
13. Log in as **admin@** → **Dashboard**: all KPIs; budget chart shows **all 3
    properties**.
14. Log in as **fm@** → **Dashboard**: ops widgets + budget chart shows **2
    properties** (Lekki + Ikoyi); no financial KPIs.
15. Log in as **owner@** → **Dashboard**: portfolio; budget chart shows **1 property**
    (Lekki only) + collection rate.
    - **Expected:** the same page renders three different, correctly-scoped views.

## 8 — Audit trail (Module 5)
16. Log in as **finance@** (or admin@) → **Audit**. Filter chips: All / Payments /
    Tickets / Budgets / Settings / Notifications.
    - **Expected:** the assignment, the acknowledgement, the payment approval and
      remittance, and status changes from this run all appear, with actor + change.
      Entries cannot be edited or deleted (append-only, DB-enforced).

## 9 — Dual-brand isolation (bonus)
17. Log in as **tfml@** → header is **navy** ("Total Facilities Management"), sees
    only its own ticket. Log in as **oea@** → header is **red**, sees only its own.
    - **Expected:** distinct branding, completely separate data, one domain, no URLs.

---

## Result log

**Build-team validation (2026-07-22, fresh seed):** data preconditions confirmed
for every step, and the money path walked live — FM sees 14 managed-property
tickets; 3 payments present in the 3 stages (FixIt pending / SecureGuard
recommended / Sparkle remitted); SecureGuard detail shows score 85.1, two gate
stages green, "Approve payment" available to finance; resident has 2025 + 2026
statements. No bugs hit. Full interactive run below is for UAT.

| Step | Pass/Fail | Note |
|---|---|---|
| 1 Tenant request | | |
| 3 FM dispatch | precondition ✓ | 14 managed tickets, 8 open/assignable |
| 4 Vendor ack | | |
| 5 Payment gate (both ways) | UI ✓ | 3 stages render; SecureGuard→Approve; FixIt block verified Day 10 |
| 6 SC statement | precondition ✓ | 2025 + 2026 charges for resident's unit |
| 7 BI scoping (3 roles) | verified | admin 3 / FM 2 / owner 1 property |
| 8 Audit trail | verified | immutable, filterable (Day 11) |
| 9 Dual-brand | verified | TFML navy / OEA red, isolated |

## Day 19 — clean re-run

Day 18 surfaced no failures, so Day 19 was used for a deeper "try to break it"
pass on the newest cross-cutting path: a **tenant** submits a portal request →
it inserts under RLS as the sender, **auto-links to their property** (Lekki
Gardens, from their occupied unit) → the **managing FM** (Abdul Owo) can see it.
Verified end-to-end: ticket created, sender correct, property auto-linked, FM
visibility confirmed. **No bugs found — clean run, nothing to fix.**
