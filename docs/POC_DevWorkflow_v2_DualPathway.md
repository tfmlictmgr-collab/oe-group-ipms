# OE GROUP AURA POC — 3-WEEK DESIGN & DEVELOPMENT WORKFLOW (FRESH BUILD)
### Claude Code as Lead Developer/Architect · Board & Client Demo-Ready
**Reference: Master Build Prompt v3.1 · Foundation POC scope**
*This replaces the prior workflow document. Two pathways are documented — pick one before Day 1.*

---

## CHOOSE YOUR PATHWAY

| | **Pathway A — Code-First (Recommended)** | **Pathway B — n8n (Redone Correctly)** |
|---|---|---|
| Intake/triage built as | Next.js API routes, real code, version-controlled | n8n visual workflows (as before, but built cleanly this time) |
| Where bugs get fixed | In the codebase, by Claude Code, testable | In n8n's UI, node by node, manually |
| Best for | Claude Code doing the real building/debugging | If you specifically want a visual, non-code workflow tool for future non-developer edits |
| Main risk avoided | All the credential-type confusion, node-type mistakes, and stale-webhook issues from manual n8n setup | None avoided — same risk class exists, just built more carefully this time |

**Recommendation: Pathway A.** Every hard problem from the last build (wrong node types, OAuth vs token credential confusion, ngrok/webhook staleness, JSON string-escaping bugs) was a symptom of manual GUI configuration, not the underlying logic. Claude Code writes and tests real code far more reliably than it can guide you through GUI clicks. Pathway A is documented in full below; Pathway B follows as a complete alternative for Week 1's intake days only — **Weeks 2 and 3 are identical regardless of pathway** and are documented once.

---

## HOW TO USE THIS DOCUMENT
- Work top to bottom. Each deliverable: **Goal → Claude Code Prompt → You Verify → Done When**.
- Paste prompts into Claude Code as-is; adjust bracketed `[...]` placeholders only.
- Don't skip "You Verify" — these are checkpoints, not formalities.
- Keep `CLAUDE.md` (master prompt v3.1) at repo root throughout.
- One deliverable per Claude Code session where practical — verify before stacking the next ask.

---

## PRE-WEEK-1 SETUP (Day 0, ~1 hour)
Do this before Day 1 regardless of pathway:
- [ ] GitHub repo created, `CLAUDE.md` (master prompt v3.1) committed at root
- [ ] `.gitignore` includes `.env`, `.env.local`, `node_modules/`
- [ ] Supabase project created, connection URL + service key ready (kept out of git, in `.env.local`)
- [ ] Anthropic API key ready
- [ ] Telegram bot created via BotFather, token ready
- [ ] Meta developer app created, WhatsApp test number + **permanent System User token** (Never-expiring — not the 24-hour temporary one) ready
- [ ] Claude Code installed, opens this repo

**Pathway A only, additionally:**
- [ ] Deployment target decided (Vercel recommended — gives you a stable public URL from Day 1, no ngrok needed)

**Pathway B only, additionally:**
- [ ] n8n installed (Cloud trial or self-hosted via Docker)
- [ ] ngrok installed, **static domain claimed** (free tier includes one — do this now, not mid-build, to avoid the URL-rotation problem from before)

---

# PATHWAY A — CODE-FIRST (Days 1–7)

### Day 1 — Project scaffold, data model, deployment pipeline
**Goal:** Next.js app live on a public URL from day one; full schema in place.

**Claude Code Prompt:**
> "Initialize a Next.js 14 app (App Router, TypeScript, Tailwind, shadcn/ui) in this repo. Connect Supabase using env vars from `.env.local`. Create the full schema per CLAUDE.md Part B and B7: `orgs` (id, name, brand, parent_org_id nullable, delivery_brand enum: TFML/OEA/direct), `users` (id, org_id, role enum matching the B7 matrix), `tickets` (id, org_id, sender_id, channel, message_text, category, urgency, summary, property_or_unit, requires_human_review, status, created_at — id as a proper auto-generated primary key, NOT sender_id), `vendors`, `vendor_evaluations`, `service_charges`, `payments`, `audit_log`. Write RLS policies enforcing B7 exactly. Set up a Vercel deployment via GitHub integration and confirm the app is live at a public URL by end of this session."

**You Verify:** Visit the live Vercel URL — even a blank/placeholder page confirms the pipeline works. Check Supabase Table Editor for all 7 tables.

**Done When:** Public URL live, schema deployed, RLS confirmed (query `tickets` with anon key → empty result).

---

### Day 2 — WhatsApp webhook as a Next.js API route
**Goal:** Real code receiving and verifying WhatsApp webhook calls — no n8n, no GUI.

**Claude Code Prompt:**
> "Create `/app/api/webhooks/whatsapp/route.ts` handling both GET (Meta's webhook verification handshake — check `hub.verify_token` against an env var, return `hub.challenge`) and POST (incoming message events). Parse the WhatsApp payload shape (`entry[0].changes[0].value.messages[0]`), explicitly ignore status-update payloads (`value.statuses` present, not `value.messages`), extract message text, sender (`wa_id`), and timestamp. Log the raw payload to console for now. Return a 200 immediately per Meta's requirement, and do any processing after responding (or in a queued follow-up) so Meta never times out waiting for us."

**You Verify:** Deploy, get the route's public URL from Vercel, register it as the Callback URL in Meta's webhook config with your verify token. Meta's "Verify and save" should succeed immediately (real server, no ngrok rotation risk).

**Done When:** Meta verification succeeds against the live Vercel URL.

---

### Day 3 — Telegram webhook as a Next.js API route
**Goal:** Same pattern, second channel.

**Claude Code Prompt:**
> "Create `/app/api/webhooks/telegram/route.ts` handling POST only (Telegram doesn't require the GET handshake). Parse `message.text`, `message.chat.id`, `message.from.first_name/username`, `message.date`. Write a small script `/scripts/set-telegram-webhook.ts` that calls Telegram's `setWebhook` API pointing at this route's live Vercel URL, and run it."

**You Verify:** Send a Telegram message, check Vercel's function logs (or a temporary console.log) to confirm the payload arrived.

**Done When:** Telegram messages reach the live route, confirmed in logs.

---

### Day 4 — Shared classification + ticket-creation logic
**Goal:** One function both webhooks call — no duplicated logic, no copy-paste drift.

**Claude Code Prompt:**
> "Create `/docs/AURA_Triage_Classification_Prompt.md` with the exact system prompt below (already validated in production testing — categories, urgency levels, and JSON output schema must not be altered):
>
> ```
> You are the intake triage classifier for OE Group's AURA facilities/property platform (TFML + OEA). Classify each inbound message from a tenant, resident, or vendor into exactly one category, extract key details, and assess urgency. Always respond with ONLY valid JSON — no preamble, no markdown, no explanation.
>
> Categories (pick exactly one):
> - "maintenance" — repair/asset issues, equipment faults, cleaning, security, pest, landscaping requests
> - "billing" — service-charge queries, invoice questions, payment issues, arrears, statements
> - "vendor" — vendor-submitted updates: job completion, invoice submission, status updates
> - "complaint" — dissatisfaction with service, staff, or conditions not tied to a specific repair
> - "general" — greetings, unclear messages, questions not fitting other categories
>
> Urgency (pick exactly one):
> - "critical" — safety hazard, no power/water, security breach, active leak/flooding
> - "high" — service materially disrupted, needs same-day attention
> - "normal" — standard request, routine timeline acceptable
> - "low" — informational, no action needed urgently
>
> Output this exact JSON shape and nothing else:
> {"category": "maintenance|billing|vendor|complaint|general", "urgency": "critical|high|normal|low", "summary": "one-sentence plain-English summary of the request", "property_or_unit": "extracted property/unit identifier if mentioned, else null", "requires_human_review": true/false}
>
> Set "requires_human_review" to true if the message is ambiguous, mentions legal/safety/financial disputes, or does not clearly fit any category.
> ```
>
> Then create `/lib/triage.ts` exporting `classifyAndCreateTicket(message_text, chat_id, sender_name, channel, org_id)`. It should: call the Claude API (model claude-sonnet-4-6) with the system prompt loaded from `/docs/AURA_Triage_Classification_Prompt.md`, parse the JSON response defensively (strip markdown fences, JSON.parse in try/catch, fall back to `{category:'general', urgency:'normal', requires_human_review:true}` on any failure), insert the resulting ticket into Supabase (mapping `category` → routing per B2: maintenance→Module 2, billing→Module 3, vendor→Module 4, complaint/general→human-reviewed log), and return the created ticket. Build the Claude API request body using the SDK or `JSON.stringify()` on a proper object — never a hand-built template string — since the system prompt and message text can contain characters that break naive string interpolation. Wire both webhook routes to call this function."

**You Verify:** Send one WhatsApp and one Telegram message, confirm both produce correctly classified tickets in Supabase with no manual JSON-escaping anywhere in the code.

**Done When:** Both channels create tickets via the shared function; check the code — there should be zero string-interpolated JSON bodies.

---

### Day 5 — Reply-back (acknowledgment) on both channels
**Claude Code Prompt:**
> "Add `/lib/notify.ts` exporting `sendReply(channel, chat_id, text)` that calls the WhatsApp Cloud API or Telegram `sendMessage` API depending on channel, using `JSON.stringify()` for request bodies. Wire it into both webhook routes to send this exact acknowledgment template immediately after ticket creation: 'Thanks — I've logged your request as ticket #{ticket_id} ({category}). Our team will follow up shortly.'"

**You Verify:** Send a message on each channel, confirm you receive the acknowledgment reply.

**Done When:** Full round-trip works on both channels, in code, on a public URL — no local machine, no ngrok, no n8n.

---

### Day 6 — Resident/Tenant Portal shell (Module 1)
*(Same as previously documented — see WEEK 2 shared section below; pull this forward if you want the portal ready alongside intake.)*

**Claude Code Prompt:**
> "Build the Resident/Tenant Portal: Supabase Auth (email/password for POC), dashboard listing the logged-in user's tickets (RLS-scoped per B7), 'New Request' form, ticket detail view, Realtime subscription so tickets created via webhook appear live. Brand theme per CLAUDE.md B2 based on org.delivery_brand."

**You Verify:** Send a WhatsApp message, watch the ticket appear in the portal within seconds without refreshing.

**Done When:** Cross-channel-to-portal live visibility confirmed — your first real demo moment, achieved one day earlier than the n8n pathway would allow.

---

### Day 7 — Week 1 checkpoint
**Claude Code Prompt:**
> "Run a full audit: list every RLS policy against the B7 matrix, list any unfinished error handling in the webhook routes or triage.ts, confirm no JSON is built via string interpolation anywhere in the codebase, and summarize what's demo-ready."

**You Verify:** Read the audit, fix any gaps now.

**Done When:** Clean audit; dual-channel intake, classification, portal all working on a public URL.

---

# PATHWAY B — n8n, REDONE CORRECTLY (Days 1–7, alternative to Pathway A)

*Use this section instead of Pathway A's Days 1–7 if you specifically want n8n. Weeks 2–3 below apply either way.*

### Day 1 — Project scaffold + schema
Same Claude Code prompt as Pathway A Day 1, minus the Vercel deployment (deploy the portal later, in Week 3).

### Day 2 — n8n environment, done right the first time
**Goal:** Avoid every setup mistake from before.

**Manual steps (no Claude Code — GUI setup):**
1. Claim your **ngrok static domain** now (Dashboard → Domains → Create). This alone prevents the single most time-consuming problem from the last build.
2. Run n8n locally, tunnel via `ngrok http --domain=your-static-domain.ngrok-free.app 5678`.
3. Create **three separate n8n workflows** from the start — never combine triggers in one workflow: `Telegram Intake`, `WhatsApp Intake`, `AURA Triage Core` (sub-workflow, entry node = "When Executed by Another Workflow" with **"Accept all data" set explicitly**, not "Define using fields below").

### Day 3 — WhatsApp setup, done right the first time
1. Meta app → WhatsApp product → **generate a permanent System User token** (Business Settings → System Users → Assign app + WhatsApp asset → Generate token, expiry Never) **before** touching n8n credentials — never use the 24-hour temporary token.
2. Register the webhook: Meta → Use cases → Customize → Step 2 Production setup → Callback URL = your **static** ngrok domain + n8n's Production webhook path, verify token = a string you invent → Verify and save.
3. Explicitly complete **"Register your WhatsApp phone number"** as its own checklist step (this was the missed step last time — Configure Webhooks and Register Phone Number are two separate completions, both required).
4. Add a payment method (required to send outbound messages, even in the free/service-window tier).

### Day 4 — Build the Core workflow with correct node types
**Key corrections from last time, applied from the start:**
- Mapping/parsing logic goes in a **Code node**, never "Edit Fields" with JSON mode set to paste raw JavaScript.
- The HTTP Request node's JSON body: build it using n8n's expression editor referencing a **JSON.stringify'd object**, not a hand-typed template string with the system prompt pasted inline — per the newly captured master-prompt lesson (A6), AI-generated text contains newlines/quotes that break string interpolation silently.
- Use the **validated system prompt** from `/docs/AURA_Triage_Classification_Prompt.md` (five categories: maintenance/billing/vendor/complaint/general; four urgency levels: critical/high/normal/low; fixed JSON output schema) — do not paraphrase or shorten it in the node.
- Route the Switch node on the parsed `category` per the prompt's routing map: maintenance→Module 2 (vendor assignment), billing→Module 3 (SC), vendor→Module 4 (payment/status), complaint/general→fallback (human-reviewed log + acknowledgment).
- Guard the very first line of the parser Code node against WhatsApp status-update payloads (`value.statuses` present → return `[]` immediately).
- Every node reference by name (e.g., `$('Code in JavaScript1')`) must match the *current* node title exactly — rename nodes deliberately and consistently, don't leave default auto-numbered names you might rename later and forget to update elsewhere.

### Day 5 — Reply-back nodes
Telegram "Send a text message" + WhatsApp "Send message" nodes, both reading from the Switch/classification output, using the **permanent** token credential (not OAuth Client ID/Secret — that's for the Trigger node only).

### Day 6 — Portal shell
Same as Pathway A Day 6.

### Day 7 — Week 1 checkpoint
Same audit as Pathway A Day 7, plus: confirm both intake workflows and Core are all **Published**, confirm zero test-mode/production-mode conflicts remain.

---

# WEEK 2 — CORE MODULES (Days 8–14, both pathways converge here)

### Day 8 — Vendor Management (Module 2)
**Claude Code Prompt:**
> "Build Vendor Management: vendor list (org-scoped), detail page showing composite score using CLAUDE.md B2 weights (Quality 30%, Response 20%, Completion 20%, Satisfaction 20%, Compliance 10%), evaluation submission form (Facility Manager role). Seed 5 synthetic vendors with sample evaluation histories."

**You Verify:** Composite scores match manual math.
**Done When:** Vendor module functional with seeded data.

---

### Day 9 — Service Charge Administration (Module 3)
**Claude Code Prompt:**
> "Build Service Charge Administration: budget creation (admin role), an apportionment engine per-unit for shared costs, auto-generated invoices, resident-facing SC statement view. Seed 3 properties with synthetic unit/apportionment data."

**You Verify:** Apportionment splits correctly across seeded units.
**Done When:** SC flow works end-to-end with synthetic data.

---

### Day 10 — Vendor Payment & Remittance (Module 4) — the gated flow
**Claude Code Prompt:**
> "Build Vendor Payment Administration implementing the CLAUDE.md B4 gate: invoice submission → service verification (Facility Manager checkbox) → performance validation (auto-pulled composite score, must exceed threshold) → payment recommendation → approval (Finance/Approver role, admin-configurable threshold) → status 'approved for remittance'. Stub the remittance step as a status change with a fake reference, clearly labeled 'SIMULATED — POC ONLY'. Do not integrate live Paystack/Flutterwave keys."

**You Verify:** Low-scoring vendor payment is blocked/flagged; high-scoring vendor reaches full approval.
**Done When:** Gate logic provably enforced both ways.

---

### Day 11 — Audit & Compliance (Module 5)
**Claude Code Prompt:**
> "Add audit logging middleware writing to audit_log on every ticket status change, payment approval, and config change. Build an Audit Trail viewer (admin/finance only) — actor, action, before/after, timestamp, filterable."

**You Verify:** Perform 3 different actions, confirm all logged correctly.
**Done When:** Every money/status action is provably logged.

---

### Day 12 — BI Dashboard (Module 6)
**Claude Code Prompt:**
> "Build the Executive Dashboard (Recharts): open/closed tickets, SC collection rate, vendor liabilities, budget utilization, vendor score distribution — live from Supabase, scoped per B7 per role. Brand tokens from CLAUDE.md B2."

**You Verify:** Different roles see correctly scoped dashboards.
**Done When:** Role-scoping confirmed correct.

---

### Day 13 — Notification cascade (B8) wired throughout
**Claude Code Prompt:**
> "Implement the B8 fallback cascade as a reusable function: WhatsApp attempt → SMS fallback (stub if no live Africa's Talking account) → Email fallback (Resend). Log every attempt/failure to audit_log. Wire to: ticket acknowledgment, payment approval, SC statement generation."

**You Verify:** Force a WhatsApp failure, confirm fallback attempt logged.
**Done When:** Cascade works and is auditable.

---

### Day 14 — Week 2 checkpoint + full access-matrix pass
**Claude Code Prompt:**
> "Cross-check every page/route against the B7 matrix for all 7 roles, test each combination, fix any mismatches. Summarize all 6 modules' state and flag anything demo-risky."

**You Verify:** Spot-check 3 role/page combinations yourself; walk through all 6 modules as if demoing.
**Done When:** No access violations; short, clear polish list for Week 3.

---

# WEEK 3 — INTEGRATION, HARDENING, DEMO PREP (Days 15–21, both pathways)

### Day 15 — Synthetic demo data pass
**Claude Code Prompt:**
> "Write a comprehensive, re-runnable seed script: 3 properties, 15 units, 5 vendors with varied histories, 20 tickets across all categories/urgencies, 2 SC billing cycles, 3 payments in different gate-stages. One command to truncate + reseed."

**Done When:** One command produces a full, convincing demo dataset.

---

### Day 16 — Deployment stability
**Pathway A:** Already live on Vercel since Day 1 — this day is just a final review: environment variables set correctly in Vercel's dashboard (not just locally), preview vs. production branch confirmed.

**Pathway B:** Move n8n off your laptop to a small always-on host (PikaPods/Hetzner ~$3–7/mo) so the demo doesn't depend on your machine staying on and connected.

**Done When:** Nothing about demo day depends on your laptop's network connection (Pathway A) or, at minimum, is on a stable static tunnel with the laptop plugged in and monitored (Pathway B).

---

### Day 17 — Security pass
**Claude Code Prompt:**
> "Run a security review: confirm no secrets in git history, all API routes check auth, RLS is the enforced backstop, webhook endpoints are rate-limited. List findings and fix criticals."

**Done When:** No exposed secrets, no unauthenticated data routes.

---

### Day 18 — End-to-end QA script
**Claude Code Prompt:**
> "Write a manual QA checklist: step-by-step demo narrative through all 6 modules in logical order (tenant request → AI triage → FM assigns vendor → completion → payment gate → SC statement → BI dashboard → audit trail), with expected result at each step."

**Done When:** You complete the full script yourself, start to finish, no bugs hit.

---

### Day 19 — Fix Day 18's findings
**Claude Code Prompt:** "Here's what broke: [paste exact failures]. Fix each one."
**Done When:** Clean re-run.

---

### Day 20 — Demo narrative + deck sync
**Action:** Update the functional design deck with 2–3 real screenshots from the live POC. Prepare a 10-minute spoken narrative following the Day 18 script order.
**Done When:** Deck + live system tell one coherent story, under 15 minutes plus Q&A room.

---

### Day 21 — Dress rehearsal + go/no-go
**Action:** Run the full demo exactly as you will for the board. Invite a colleague to try to break it.
**Done When:** Survives rehearsal. Remaining buffer time (if any) is for fixing what surfaced today only — no new features.

---

## STANDING RULES (both pathways, all 3 weeks)
1. Never commit `.env`/`.env.local` — confirm `.gitignore` on Day 0.
2. One deliverable per Claude Code session where practical; verify before stacking the next.
3. Paste exact errors, not descriptions, when something breaks.
4. Update `CLAUDE.md` if you deviate from the master prompt — keep it the single evolving source of truth.
5. No live payment gateway keys during the POC — Day 10's remittance stub is intentional; live money movement is a Phase 1 Production decision.
6. **JSON.stringify rule (newly captured):** anywhere a JSON body is constructed for an outbound API call — Claude API, WhatsApp API, or otherwise — build it as a real object and serialize with `JSON.stringify()`, never a string template with AI-generated or user text spliced in directly.
