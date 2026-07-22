# Board Demo — Spoken Narrative (Day 20)

**Duration:** ~10 minutes live + Q&A. **Surface:** `https://oe-group-ipms.vercel.app`.
**Golden rule:** run `npm run seed` beforehand; keep the 9 logins on a sticky note
(all password `OEGroupDemo2026!`). Speak the *value*, click the *proof*.

---

### 0 · Opening — 30s
> "What you're seeing is a working, cloud-hosted system — not slides. It unifies
> TFML's facilities work and OEA's property management on one secure backend, it's
> WhatsApp-first because that's where our users already are, and it was built
> in-house, AI-led. Six modules are live. Let me walk a single request all the way
> from a tenant's phone to a board-level number."

*(Have `demo@` / admin already logged in on the dashboard.)*

---

### 1 · Intake & AI triage — 1.5 min · Module 1
**Do:** Point at the live request list (updating in real time).
> "A resident sends a message — WhatsApp, Telegram, or the portal. Our AI reads it,
> decides what it is and how urgent, and logs a ticket automatically. No call
> centre, no manual sorting."

**Proof point:** open any channel ticket — the title is the AI's own summary.
> "On a held-out test set the classifier put the request in the right category
> **100% of the time**, and priority within one step every time. And crucially —"
> *(open a ticket)* "— a human can always correct it. AI does the toil; people keep
> judgement."

---

### 2 · Dispatch & accountability — 1.5 min · Module 2 + dispatch
**Do:** Log in as **fm@** (Abdul Owo, Facility Manager).
> "This is a Facility Manager. Notice he sees **only his properties'** requests —
> Lekki and Ikoyi, not Victoria. Access follows responsibility."

Open an open ticket → **Dispatch** → Sparkle Cleaning → **Assign & notify**.
> "He assigns it to a vendor, who's notified automatically."

**Do:** Log in as **vendor@** → open the job → **Acknowledge**.
> "The vendor sees only the jobs assigned to them, and confirms receipt. Every hand-
> off is timestamped and recorded — accountability by construction."

---

### 3 · The money controls — 2.5 min · Module 4 *(the centrepiece)*
**Do:** Log in as **finance@** (Oke Anderson) → **Payments** → open **SecureGuard**.
> "Here's where the board should lean in. No vendor gets paid on trust. Every
> payment passes a gate: service verified, **performance validated against the
> vendor's own KPI score**, approved, then remitted."

Show the score 85.1 vs threshold 70 → **Approve** → **Execute remittance**.
> "This vendor scores 85 against a threshold of 70, set by an administrator. It
> passes, gets approved, and remits — simulated here, no live gateway in the pilot."

**Do:** open **FixIt** → **Verify** → **Run performance check**.
> "Now watch a *weak* vendor. Score 53 — below the line. The system **blocks the
> payment**. It is not possible to remit to an underperforming vendor. That control
> is enforced in the database, not just the screen."

---

### 4 · Service-charge administration — 1.5 min · Module 3
**Do:** As admin, **Service Charges** → a budget → the apportionment table.
> "Annual service charges are apportioned across every unit automatically — and it
> reconciles to the last kobo."

**Do:** Log in as **resident@** → **Statements**.
> "The resident sees only their own statement — their unit, their share, across
> billing cycles. Full transparency, correctly scoped."

---

### 5 · Executive visibility, role-scoped — 1.5 min · Module 6
**Do:** As **admin@** → **Dashboard** (all three properties, all KPIs).
> "The executive view: collections, receivables, vendor liabilities, budgets — live."

**Do:** switch to **owner@** → **Dashboard**.
> "The *same page* for a property owner shows **only their portfolio** — one
> property, their collection rate. One dashboard, every role sees exactly their
> slice. Nothing over-shared."

---

### 6 · Trust & isolation — 1 min · Module 5 + dual-brand
**Do:** As finance/admin → **Audit**.
> "Everything we just did is here — the assignment, the approval, the remittance —
> with who did it and when. It **cannot be edited or deleted**; the database itself
> forbids it. That's the compliance backbone."

**Do:** Log in as **tfml@** (navy), then **oea@** (red).
> "Finally — two brands, one system. TFML and OEA each get their own look and see
> **completely separate data**, on one platform, with no separate websites to
> maintain."

---

### 7 · Close — 30s
> "Six modules, live on managed cloud — nothing running on my laptop. AI where it
> removes toil, humans where money moves, and every action on the record. This is
> the pilot. Phase 1 hardens it for production — self-service onboarding, live
> payments, tenant-driven vendor reviews. I'll take your questions."

---

## Timing / fallback
- Total ≈ 10 min. If short on time, cut §4 and §6-dual-brand; **never cut §3**.
- If live WhatsApp intake is desired, confirm the number is allow-listed first;
  otherwise demo intake via the portal or Telegram (both reliable).
- Rollback: any prior Vercel deployment can be promoted from the dashboard.

## Screenshot shot-list (for the deck)

Capture these full-resolution from your own browser (⌘/Ctrl-Shift-4 or the browser
device toolbar at ~1440px wide) — crisper than any tool export. Log in, go to the
URL, frame as noted.

| # | Login | URL | Frame | Deck slide |
|---|-------|-----|-------|-----------|
| 1 | `demo@` | `/dashboard/bi` | Full dashboard — KPI tiles + all charts | Executive visibility |
| 2 | `finance@` | `/dashboard/payments/<SecureGuard>` | Gate stepper + "85.1 vs 70" + Approve | The money controls (pass) |
| 3 | `finance@` | `/dashboard/payments/<FixIt>` after perf check | "Rejected — blocked" | The money controls (block) |
| 4 | `resident@` | `/dashboard/statements` | The single scoped statement | Service-charge transparency |
| 5 | `finance@` | `/dashboard/audit` | The audit table + filter chips | Compliance / audit |
| 6 | `tfml@` then `oea@` | `/dashboard` | Two headers side by side (navy vs red) | Dual-brand isolation |
| 7 | `owner@` | `/dashboard/bi` | Portfolio (1 property) next to shot #1 | Role-scoping proof |

Tip for #6/#7: the power of the story is the *contrast* — put the two shots on one
slide so the different data/branding is obvious at a glance.
