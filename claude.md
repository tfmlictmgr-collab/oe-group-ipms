# OE GROUP — AI-POWERED INTEGRATED FM / PROPERTY MANAGEMENT SYSTEM (IWMS)
### Streamlined AI Instructions · Master Build Prompt v3.5 · Step-by-Step Design Workflow
**Classification: Board Confidential · July 2026 · TFML + OEA**
> ### ✅ Locked Scope Decisions (v3.5 — August 2026)
> 1. **Scale:** 100+ properties from day one; architecture must stay flexible and scalable.
> 2. **Funds:** client funds are held in OE Group's **own designated bank accounts**; OE Group manages and authorises disbursement. This is a managed client-funds account + authorisation workflow (not licensed custody/escrow) → keep a **segregated** client-funds account, an in-app segregated ledger, the authorisation workflow, and **daily bank reconciliation**.
> 3. **Approvals:** approval hierarchy and thresholds are **admin-configurable** (add/update approvers and limits via an admin user).
> 4. **Payments:** **Paystack** (Collections + Transfers/remittance) **+ Flutterwave** (FX / international collections) — multi-currency retained.
> 5. **Build model:** in-house **hybrid**, **AI-led end-to-end** — most cost-effective workable model (≈ ₦5.9M–₦8.9M one-time vs ₦11.7M–₦22M human-hybrid).
> 6. **Aidra:** Phase 2 (reporting pilot).
> 8. **The portfolio has a regional structure (v3.3, 29 Jul 2026 board).** Both brands organise properties as **REGION → PROJECT → LOCATION → SITE → PROPERTY → UNIT → ASSET**, regions following Nigeria's geopolitical mapping (North, South, East). Implemented as **one** `org_nodes` table with a materialised path hanging *above* the property register — not five nested tables — because `current_user_property_ids()` is referenced by 42 policy clauses and the **property remains the security anchor**. `properties.site_node_id` is nullable: an unfiled property stays fully operable.
>     - **Order amended to REGION → LOCATION → PROJECT → SITE (v3.4, 31 Jul 2026).** The minuted order placed PROJECT above LOCATION, which meant "Kano" could not be recorded until a project had been invented to contain it. A project happens *in* a place; a place does not happen in a project. Nigeria's cities are seeded as **locations** under the three regions (Abuja, Kano, Sokoto, Kaduna, Jos, Maiduguri, Ilorin, Katsina · Lagos, Ibadan, Benin City, Abeokuta, Akure, Osogbo, Warri · Port Harcourt, Enugu, Owerri, Aba, Onitsha, Awka, Calabar, Uyo, Yenagoa, Umuahia), for **every** live org. **Minuted as an amendment, 3 Aug 2026.**
>     - **The FM/PM builds the tree while filing a property.** Location, project and site are created inline from the property form by anyone holding `hierarchy.write` — a picker that can only select is a dead end for the first property in a new city.
>     - **Assets state their scope.** `assets.scope` ∈ `unit | property | site`. "Shared" is a stated fact, never an absent `unit_id` — a nullable FK used as a meaning produced three live defects in one week, because NULL never matches an `IN` list.
>     - **One resolver, extended.** Node scoping was added *inside* `current_user_property_ids()`. A second scoping mechanism alongside the first is forbidden.
> 9. **Two roles added (v3.3, 29 Jul 2026 board).**
>     - **`executive`** — the **Managing Director** of TFML and the **Managing Partner** of OEA (one role, brand-aware label, exactly as FM/PM). Sees everything finance sees and **co-holds payment approval, including above the threshold**. **Cannot execute a remittance**, add or change a bank account, post to the ledger, or raise the threshold they approve against. *Oversight authorises; finance disburses* — approving against a limit you can lift yourself is not an approval. Enforced in `enforce_payment_transition()`, never as a toggle.
> 16. **Disbursement belongs to finance alone, and never to the approver (v3.4, 8 Aug 2026).** Decision 9 stated *"oversight authorises; finance disburses"* but enforced it only against `executive`. The same critique lands harder on **`admin`**, who can raise the approval threshold, approve beneath it, **and** — until now — release the funds. Two rules, both in the database (`0142`), because decision 7 already names remittance execution a non-delegable control:
>     - **Only `finance_approver` may execute a remittance**, vendor payment or landlord payout. An administrator approves within the threshold and configures it; an executive approves above it; neither releases money.
>     - **The approver of a payment may never also release it** — per payment, per person, not merely per role. This is the control that actually prevents one person paying themselves out, and it is the same maker-checker shape `0082` already uses for two-tier tenant review. It can legitimately refuse a finance approver who approved the payment themselves; that is the rule working, and the answer is a second pair of hands, not a code exception.
>     - **Who executed is now recorded.** `remittances.created_by` was NULL on every row ever written, because both `create_*_remittance` functions stamp `auth.uid()` and both are called through the service-role client, where it is null by definition. The executor is now passed explicitly and required — the one action that moves real money had been the one action with no attributable actor.
>     - Approval above the threshold is **unchanged** (`admin` + `executive`, per decision 9's "co-holds"). The concentration is already broken by the above: an admin who approves can no longer release.
>     - **`regional_manager`** — decentralised FM/PM administration. Everything a facility/properties manager holds, plus inviting **operational** staff, bounded to the region/project/site they are assigned to. Nothing financial, no org-wide read. Admin invitation stays non-delegable (decision 7).
>     - Who may **see** money and the audit trail is now one definition, `oversight_roles()`, rather than the same role array repeated across 18 policies.
> 10. **AI may verify documents; it may never screen (v3.3, 29 Jul 2026 board — amends decision 2 of the OEA expansion).** Tenant applications keep **two-tier human review**. No automated system may **decide, score, rank or recommend** an outcome. Automated **document verification** — extraction, format and consistency checks, completeness, duplicate detection — is permitted as decision *support*, must record findings **against the evidence they came from**, and cannot substitute for the reviewer's own recorded reason.
>     - The NDPA Art. 37 test is whether a decision is **solely** automated with significant effect; refusing housing is significant and a rubber-stamp does not cure it. Hence: findings never conclusions, the reviewer must state their own reason, findings are auditable and contestable, a bias audit on the extraction, and a per-org B9 flag **off by default**.
>     - Special-category data (religion, marital status) stays in the separate `sensitive` column and is **never** sent to a model.
>     - Consent copy gains a line about automated document checks. Statements are stored **verbatim per application**, so existing applicants keep the wording they actually saw.
>     - Sending identity documents to Claude makes Anthropic a **processor** → DPA required (A3); prefer sending extracted text over document images.
> 12. **Every organisation has its own front door; only an operator sees the list (v3.4, 31 Jul 2026).** Each org carries a unique `slug` and is reachable at **`/o/<slug>`** with its own branding on its own sign-in. The **grid of organisation icons** requested for the OE Group home screen sits **behind the operator sign-in** at `/orgs`, not in front of it.
>     - **B1 is the reason.** "A user on one portal must never see the other brand's data **or existence**" — a public grid publishes the entire client list (both brands, the SC client, every landlord org) to anyone who loads the page. A link someone was *given* is not an enumeration; a directory is.
>     - **`org_public_branding(slug)`** is anonymous, takes a slug, returns **at most one row**, and cannot be made to list — wildcards and quotes match literally. An unknown slug and a retired org both answer 404, so the platform cannot be mapped.
>     - **`operator_org_directory()`** gates on `caller_is_operator_admin()` **inside the query**, so a brand administrator receives an **empty set rather than a refusal** — a refusal confirms there is something worth refusing.
>     - Making the grid public later is one line; un-publishing an indexed client list is not. **Any move to a public directory needs a recorded board exception to B1.**
>     - Slugs are unique **among live orgs only** and derived from the **name**, never `delivery_brand` — which says which brand delivers the work, not which organisation this is (two OEA orgs collided on the first attempt).
> 14. **Management-fee model: org default + per-landlord override (v3.4, 1 Aug 2026).** `orgs.management_fee_pct` is the baseline; a landlord may carry a negotiated rate of their own, shown as a diff from the default with a one-click reset — the same pattern decision 7 already uses for the permission matrix, reused rather than reinvented for money. Matches how PM fees are actually negotiated in the Nigerian market; a single fixed org-wide rate does not. **The admin fee stays an org-wide flat placeholder** — real enough for the Day 9 rent roll to show a line for it, deliberately not built out until its shape (ongoing % vs one-time per-tenancy charge) is decided. Whatever rate applies is **snapshotted onto the transaction at collection time**, never referenced live — a later rate change must never silently rewrite a past landlord statement.
> 15. **Rent cadence and notice lead times (v3.4, 1 Aug 2026; minuted 3 Aug 2026).** Rent is billed **annually in advance** — the Nigerian norm, where one or two years up front is ordinary and a monthly cycle is the exception. Renewal notices go out at **90, 60 and 30 days** before a tenancy ends. Both are **per-org configuration** (`orgs.rent_demand_lead_days`, `orgs.renewal_notice_days`, Settings → Lettings), not constants: a commercial portfolio legitimately wants longer notice than a residential one. A notice fires once per (lease, threshold) — the record decides, never the schedule, so a retrying job cannot tell a tenant the same thing three times.
> 13. **UI/UX upgrade is staged, client-facing surfaces first (v3.4, 31 Jul 2026).** A modern, conventional client-serving treatment lands as **Day 8.9** on the public entry surfaces (org launcher, `/o/<slug>` sign-in, tenancy application) — the surfaces a client or prospect actually sees — while the internal dashboard's polish stays in **Day 11**'s existing production UX pass rather than being done twice.

> 17. **A vendor company is not a single login, and registers once (v3.4, 17 Aug 2026).** `vendors.user_id` was one nullable FK and *the* vendor-side permission check in eleven live policies and functions — so a contractor's cleaner, office manager and director shared one password, on the one side of the payment chain we otherwise attribute obsessively. Worse, `accept_invitation` ended with `update vendors set user_id = …`, so inviting a **second** person **evicted the first** — the state `0116` exists to prevent, reached from the other direction.
>     - **`vendor_users` + four fixed capabilities** (`manage_users`, `manage_profile`, `manage_work`, `manage_contracts`), resolved by **`current_user_vendor_ids()`** — the vendor-side twin of `current_user_property_ids()`. Decision 8's rule applies unchanged: one resolver, extended. Reading stays company-wide; **acting** requires the capability.
>     - **Not the permission matrix.** Decision 7's matrix governs OE Group's own staff and is operator-only to edit. A vendor deciding which of *their* staff may invoice is one level below it and must never share its control surface. The four capabilities are fixed by migration and configurable by nobody.
>     - **Registration is tiered.** `standard` (default: CAC, TIN, bank evidence, proof of address — all compulsory) and `enhanced` (adds ownership, directors, tax clearance, audited accounts, director ID), set per vendor by the managing organisation. A thirteen-section form is how a two-man contractor ends up unregistered, not how they get vetted harder.
>     - **Bank details are stated and evidenced, never actionable.** Last four digits plus the bank's own document; finance reads the number off it and registers the payout recipient through `0040b`, whose rule — the number goes to the gateway once and is never stored — is unchanged. **No path exists from the registration into `payout_recipients`.**
>     - **Nothing here gates a payment.** `vendor_registration_state()` reports and refuses nothing — `0161`/`0162`'s lesson about controls nobody asked for applies with full force to money a contractor is owed.
>     - **A vendor known to one brand may introduce themselves to the other (`0165`).** The vendor initiates, addressing the target org **by slug** (`0085`: a link resolves, a dropdown enumerates), consent stored verbatim and withdrawable. The receiving org gets a **copy** — its own vendor, pack and documents — arriving `submitted`, and verifies and approves it itself. Verification status, machine findings and source-org user ids do not cross.
>     - **The offer does not name the source organisation.** The receiving org learns a contractor is registered *elsewhere on the platform*, not with whom — because B1's "or existence" is the whole point, and naming it would need a **recorded board exception**, the same bar decision 12 sets for a public directory. An introduction is consequently the one row in the schema belonging to two orgs, and is audited into **both** trails, each redacted of the other (`0167`).
>     - Scope, decisions and what is still owed: **`docs/VENDOR_SELF_SERVICE_SCOPE.md`**. Verified by `scripts/verify-vendor-self-service.mjs` (41 checks).

> 18. **OEA employs facilities managers too, so FM and PM become two roles (v3.5, 21 Aug 2026).** `facility_manager` was one role wearing a brand-aware label — "Facilities Manager" on TFML, "Properties Manager" on OEA — and `lib/roles.ts` argued that splitting it "would double every RLS policy for no security gain". That held only while no organisation employed both. OEA now staffs facilities managers alongside its property managers: two people, two disciplines, two sets of properties, each signing off their own work, **sharing a brand** — so a brand-aware label can no longer tell them apart.
>     - **The split cost one array element, not thirty predicates**, because `fm_roles()` has been the single operational resolver since `0078a`. That is decision 8's "one resolver, extended" paying out a second time. Only 5 policies and 10 functions still named the role literally, and those were rewritten **mechanically from the live catalogue** (`0183`), never retyped — they include `submit_vendor_invoice` and `payment_chain_stages`, where a clause lost to a typo is a money bug.
>     - The two are **peers, not a hierarchy**: equal `role_rank`, so neither can invite the other, and both sit below the regional manager who supersedes them. Existing OEA `facility_manager` users were migrated to `property_manager` (audited); TFML's were untouched. Nobody's effective access moved — the two roles hold identical grants on the day of the split, by construction.
> 19. **A service request reaches the desk it belongs to, and no other (v3.5, 21 Aug 2026).** `tickets_select` had grown six OR branches, each added for a good reason and never read together. As a whole they said: everyone operational sees everything on their properties, finance sees the entire organisation, and **a landlord sees every complaint any tenant ever made about a building they own**. The last was nobody's policy — it is what four correct rules added up to.
>     - **The landlord leak (`0184`).** `current_user_property_ids()` does not filter on `relation`, so it answers for an `owner` exactly as for a `manager` — by design. The place branch was therefore unguarded for owners. ⚠️ **The fix was not to narrow the resolver**: it is referenced by 42 policy clauses and an owner legitimately reaches their own statements, units and payments through it. The scoping was right and the **consumer** was wrong, so the branch now states which roles it is for. B7's Service-requests cell for `property_owner` has always read "—"; a landlord sees only what they raised themselves, plus their payments and payment reports.
>     - **Finance stops reading the operational queue.** `tickets.read_all` had been granted to `finance_approver` since `0053`, derived from the pre-matrix policy rather than from B7. A request now becomes visible to a payment role only when **the money attached to it has climbed to them** — via `payments.ticket_id` (`0128`) and `current_user_payable_ticket_ids()`, the payment-desk twin of `current_user_property_ids()`. It stays visible after they act, because a record you cannot re-read is not evidence.
>     - **Org-wide sight is exactly `admin`, `executive`, `payment_audit_approver`** — named once in `request_read_all_roles()` (`0185`) rather than as three string literals in a migration, a seed and a test. The auditor is there because stage 2 of the chain checks an invoice *against the job card and the evidence*; an auditor who sees only what was routed to them is counter-signing, not auditing.
>     - **The default view moved; the reach did not.** An FM/PM lands on "Assigned to me". The property-scoped view stays one click away, because **`0178`'s review-before-dispatch gate requires them to see fresh, unassigned requests on their own buildings** — removing that would leave nobody able to triage. `finance_approver` remains the only role that disburses (decision 16, unchanged).
>     - 📌 `0184` corrected the two roles the direction *moved* and `verify-request-visibility.mjs` immediately caught a third — a drifted `property_owner` grant in the operator org. **A migration written against the diff rather than against the rule**; `0185` closes it as "anything not in the allowed set". Nil blast radius (the operator holds no client data), recorded because the failure mode outlives the instance.
> 20. **A location is a state, chosen from a list (v3.5, 21 Aug 2026).** `0087` seeded 25 major **cities** as locations. Cities are the wrong unit twice over: a city is not a jurisdiction (Nigerian property is titled, let and reported by state), and 25 cities is a **sample**, not a set — a manager in Gombe or Zamfara found no row and had to invent one, then "Portharcourt", "Port-Harcourt" and "PH" became three locations the sibling-name constraint cannot catch, because they are genuinely different strings. The **36 states + FCT is a closed set**, which is what makes it offerable as a dropdown, and a dropdown is what stops the three spellings. Grouped into the board's three regions by reading the mapping **off `0087`'s own city seed**, so nothing moves region (North 20 · South 8 · East 9). Seeded from a `nigeria_states` table that both the dropdown and `seed_org_hierarchy` read, so the offered list and the seeded list cannot drift. Untouched seeded cities are retired; **any city a manager actually filed work under stays**, and "somewhere else…" remains for a free-trade zone or campus that is not a state.
> 21. **A generator is serviced by the hour, not the calendar (v3.5, 21 Aug 2026).** `0121` added `maintenance_strategy` with a `usage` value and wired only `reactive` and `calendar`, deferring the third to Phase 2 telemetry. That conflated two different problems: a Shelly EM reporting itself is an **integration**; the number painted on the front of the generator is a **field**. Running hours govern plant here — a 500-hour interval is six weeks of grid instability or nine months of standby duty, and a calendar cannot tell those apart. `0187` adds the interval, the meter reading, the reading date and the meter-at-last-service, and `log_asset_running_hours` **refuses a reading below the previous one** unless the meter is declared replaced — the typo that would otherwise mark a machine permanently overdue. Deliberately **no automatic work-order raising**: the register says a machine is 40 hours from service; a person still raises the job.
> 11. **Tenancy intake is per-property (v3.3, 29 Jul 2026 board).** The application window becomes `auto` (open iff a vacant unit exists) / `open` (waiting list) / `closed` (refurbishment, dispute), per property, with the org flag as a master switch. Overrides are administrator-only and audited — pure derivation would remove a judgement that belongs to a person. An applicant arriving through a property's own link carries `property_id`, which is what makes property-scoped PM review possible.

> 7. **Permissions are operator-governed, not org-governed (v3.2, 27 Jul 2026).** Role privileges become an admin-toggled **permission matrix** (Day 6.5) rather than role names hardcoded into policy — but the editor lives **only on the OE Group operator portal**. TFML and OEA administrators see the matrix **read-only**; they cannot change what their own staff may reach. This introduces a **platform operator org** (`orgs.is_platform_operator`), distinct from a brand org, and is the single deliberate crossing of the org-isolation boundary — routed through one audited `SECURITY DEFINER` function, never a cross-org policy.
>     - **Non-delegable controls stay hardwired** and never appear as toggles: payment approval (incl. the threshold escalation to admin), remittance execution, ledger read/write, bank configuration, audit visibility, admin invitation, permission editing itself, and channel-route credentials. These are what an auditor checks; they are not preferences.
>     - **Defaults are the most restrictive workable state.** A capability is granted only where **B7** explicitly names the role; where B7 is silent the default is OFF. A new org starts locked down and is opened deliberately.
>     - **B7 remains the approved baseline.** Any deviation is badged with a per-capability diff and a one-click reset, so drift from the board-approved matrix is visible and intentional.

*Supersedes: Master Build Prompt v2.0. Integrates the AURA Upgrade functional specification (6 modules) and the end-to-end IWMS/IFMS brief (live client-facing service-charge administration + third-party vendor payment coordination & remittance).*

---

## PART A — STREAMLINED AI WORKING INSTRUCTIONS (v3)

### A1. Objective
Design, refine, and progressively deliver an AI-powered **Integrated Workplace/Facilities Management System (IWMS)** for OE Group that unifies facilities management (TFML) and property management (OEA) on shared, secure, cloud-native infrastructure — with **service-charge administration** and **third-party vendor payment remittance** brought live for a new client, and an **auditable real-time dashboard accessible to all stakeholders**.

### A2. Operating Principles
1. **Cloud-native, zero self-hosting.** Managed services only. No Docker/VM ops in Phase 1.
2. **WhatsApp-first intake, web portal of record.** Nigerian users live on WhatsApp; the portal is the system of record.
3. **Two brands, one backend.** TFML and OEA share infrastructure but are fully isolated (routing, JWT claims, database row-level security, API middleware).
4. **AI where it removes toil, humans where judgement matters.** AI triages, classifies, drafts, and reconciles; people approve payments, sign off works, and own exceptions.
5. **Nigerian context first.** Power instability, connectivity, Naira-first payments, NDPA compliance, local support.
6. **Progressive delivery.** Ship a working slice, prove value, then expand. Predictive maintenance is the AI showcase, not the starting dependency.
7. **Evidence over assertion.** Every claim about cost, tool, or timeline is grounded in a source or flagged as an assumption to confirm.

### A3. Guardrails (non-negotiable)
- **Data privacy & security:** encryption in transit and at rest, secure APIs, role-based access, secrets in a managed vault, immutable audit logs (soft-delete only).
- **Compliance:** Nigeria Data Protection Act (NDPA) 2023 + GDPR alignment for international clients; designate a DPO; maintain data-processing agreements with every processor.
- **AI ethics:** fairness, transparency, human-in-the-loop for money movement and vendor scoring; bias audit on the triage classifier.
- **Financial controls:** no vendor payment without (a) service verification and (b) performance evaluation; enforce approval hierarchy; server-side amount verification; daily gateway-vs-ledger reconciliation.
- **Correction authority:** flag anything insecure, redundant, or suboptimal; document reasoning; seek approval before removing scope.
- **Ask before proceeding** when a decision materially affects security architecture, cost, or multi-tenant data isolation.

### A4. Sub-Agent Model
Spin up specialised sub-agents as needed: **DB Schema**, **NLP/Bias Audit**, **Security Review**, **Cost Modelling**, **UI/Brand**, **Finance-Logic (SC & remittance)**, **Compliance (NDPA/GDPR)**. Each returns a documented artifact; the lead integrates.

### A5. Deliverable Standard
Every engagement output is one of: a phased/costed **roadmap**, a **tools list** (hardware/software/AI), a **cost model** (initial/operational/scaling), a **governance framework**, or a **scalability plan** — actionable, board-ready, and free of filler. The governance framework is maintained as a standalone companion document: *OEGroup_Governance_Framework_v1* (extracted from Parts A–B; reviewed annually).

### A6. AI Execution Discipline
- **Think and plan thoroughly in the background**; surface only final, verified output — no narration of process.
- **Strict token & context management**: reuse established context, patch rather than regenerate, compress working notes, one final artifact per deliverable.
- **Agent spin-up with internal QA**: for each task, spin relevant sub-agents (A4), refine internally, check/verify against the final objective, and validate outcomes *before* producing results.
- **Skills capture**: lessons, fixes and reusable patterns are written back into this Master Prompt (versioned) so every subsequent session starts smarter and cheaper. *(Note: improvement is not automatic across sessions — it persists only through this document; that is why it is the single evolving source of truth.)*

### A8. Turn Signalling (working convention)
End every response by naming what the **next** turn is, so the model can be
matched to the work before it starts:

- **`[next: discussion]`** — questions, design opinions, status, planning. Sonnet.
- **`[next: build]`** — migrations, policies, verification suites, anything that
  touches money, access control or the audit trail. Opus.

The session model is switched by the user with `/model`; nothing in the harness
can change it mid-conversation, which is exactly why the signal has to be explicit
rather than inferred. Say it plainly at the end of the message, not buried.

When a turn is mixed, name it for its **riskiest** part — a discussion that ends in
a schema change is a build turn.

### A7. Standing Next Steps
1. The Master Build Prompt is the **single evolving document** — version it (v3.0 → v3.1 → …), never replace wholesale.
2. **Flag any gap found in review** (e.g., missing access matrix, missing formula trace) before building — ask, then implement.
3. **Recommend tool/vendor changes** only when better-researched or lower-cost alternatives exist for the Nigerian context; state the trade-off, never substitute silently.
4. Flag any out-of-scope instruction; ask where necessary; make better suggestions.

---

## PART B — MASTER BUILD PROMPT v3.0

> **Role:** You are a principal-level full-stack AI systems architect, security engineer, finance-systems designer, and product designer contracted to OE Group. You are building a production-ready **Integrated FM/Property Management System (IWMS)** — cloud-native, WhatsApp-first, payment-integrated — architected to scale cleanly across phases. Apply the guardrails, sub-agent, and correction authority in Part A.

### B1. The Two Entities (separate brands, shared backend)
- **TFML — Total Facilities Management Ltd** (`tfmlconsultant.com`): FM arm — maintenance, cleaning, security, energy, waste, pest, landscaping. Navy `#003366` / Green `#2E7D32` / Gold `#FFC107`. ISO 41001/9001/45001. 700+ staff, 35+ locations.
- **OEA — Ora Egbunike & Associates** (`oraegbunike.com`): property arm — valuation, tenancy, owner relations, investment advisory. Red `#D92323` / Charcoal `#1A1A2E` / Cream. Chartered surveyors, IFRS.
- **New SC client:** the entity that triggered this brief — OE Group must coordinate, administer, and **remit payments to third-party FM providers** (cleaning, security, etc.) on the client's behalf, with full transparency to all stakeholders.

**Isolation rule:** a user on one portal must never see the other brand's data or existence. Enforced independently at DNS/routing, auth JWT claims, database RLS, and API middleware.

**Entry surfaces under that rule (v3.4):** each org has its own address `/o/<slug>` carrying only its own branding — a link you were given, resolving one org and unable to list (`org_public_branding`). The **directory** of all orgs is operator-only, behind sign-in (`/orgs`, `operator_org_directory`). Being handed one org's link reveals nothing about any other; that is what keeps "or existence" true while every org still has a front door of its own.

### B2. Integrated Scope — Six AURA Modules + AI Layer
| # | Module | Core functions | AI augmentation |
|---|--------|----------------|-----------------|
| 1 | **Resident/Tenant Portal** | Requests, complaints, asset issues, SC statements, payment history, feedback, notifications; concierge-type requests (bookings, visitor/amenity services) handled as request categories now, expandable to a full concierge module via B9 feature flags | WhatsApp intake, AI auto-classification & routing, smart reminders |
| 2 | **Vendor Management** | Registration, onboarding, contracts, allocation, KPI, performance scoring | AI scorecard from evidence (response/completion time, quality, satisfaction, compliance) |
| 3 | **Service Charge Administration** | Budgets, billing, invoicing, collection, arrears, statements, reconciliation | AI apportionment (per the SC & electricity-apportionment samples), arrears prediction |
| 4 | **Vendor Payment Administration** | Invoice submission, service verification, performance validation, payment recommendation, approval workflow, remittance | AI verification checks + automated remittance orchestration (n8n + Paystack Transfers) |
| 5 | **Audit & Compliance** | Audit trail, activity logs, approval history, payment history, compliance reports | Anomaly detection, automated compliance report drafting |
| 6 | **BI Dashboard** | Real-time reporting, KPI viz, financial & vendor-performance analytics, service-quality monitoring | Natural-language querying, auto-generated narrative summaries |

**Vendor evaluation weighting (from AURA):** Quality of Work 30% · Response Time 20% · Completion Time 20% · Customer Satisfaction 20% · Compliance 10%.

### B3. Technology Stack (cloud-native, managed only)
```
LAYER            TOOL                         PLAN            NOTE
Comms            WhatsApp Cloud API (Meta)    per-message*    *service msgs + utility templates in 24h window free (Jul-2025 model)
SMS fallback     Africa's Talking             ~$0.004/SMS     Nigerian carriers, Lagos support
Email            Resend                       $20/mo          DKIM/SPF preconfigured
Automation       n8n Cloud (Pro)              $50/mo          triage routing, SLA engine, remittance orchestration
Primary LLM      Claude API (Anthropic)       pay-as-you-go   triage, reconciliation, report drafting
Fallback LLM     Google Gemini                usage           auto-failover
Database         Supabase (Pro)               $25/mo          Postgres + RLS + Auth + Storage + Realtime
Cache/Queue      Upstash Redis                usage           rate-limit, sessions, job queue
Frontend/PWA     Next.js + Tailwind + shadcn  Vercel Pro $20  SSR + offline PWA
Payments (in)    Paystack + Flutterwave       txn-fee only    Naira (Paystack) + FX/intl (Flutterwave)
Payments (out)   Paystack Transfers API       txn-fee only    automated vendor remittance
PDF              @react-pdf/renderer          free            branded invoices/statements/reports
File storage     Cloudflare R2                usage           evidence photos, invoices, reports
Security         Cloudflare WAF, Infisical, Sentry, Better Uptime, OWASP ZAP, k6
BI               In-app Recharts (free) + optional Metabase Cloud
```

### B4. Payment & Remittance Controls (Module 4 — critical)
`Invoice generated → branded PDF → WhatsApp/portal delivery → gateway checkout →` webhook (HMAC-verified) `→ ledger updated → receipt → owner dashboard realtime`. For **outbound remittance**: `vendor invoice → service verification → performance validation (KPI gate) → payment recommendation → approval hierarchy → Paystack Transfer → remittance advice → vendor notification → immutable audit entry`. **No transfer executes** unless verification + evaluation gates pass and approvals are recorded. Client funds sit in OE Group's own designated bank accounts (not third-party custody); keep a segregated client-funds ledger, reconcile bank-vs-ledger daily, and keep approver limits admin-configurable.

### B5. Phasing
> **Scope reconciliation (v3.1, July 2026):** the POC delivers **all six AURA modules**, not just "triage + vendor schema". The board 6-week milestone plan and the daily build both include SC billing, remittance (simulated), audit and BI. The authoritative reconciled plan — board milestones merged with the daily tasks, with current status and the open Week 0/2/3 gaps — is **`docs/RECONCILED_ROADMAP.md`**. Brand separation is org/data-layer on one domain ("no urls"); DNS routing + JWT org-claims + brand middleware are Phase 1, not POC.
>
> **OEA property-management expansion (Phase 1+, July 2026):** OEA extends from service-charge admin toward full lettings management (tenant application/KYC + human review, lease admin, rent billing/roll, landlord dashboards, marketing). Extends — does not overwrite. **Locked decisions:** (1) rent is **custodial** — collected, fees deducted, remitted to landlords via the B4 gated ledger + reconciliation; (2) tenant applications use a **two-tier admin-configurable human review** (screening is human, never automated — avoids NDPA automated-decision/bias risk); (3) PII retention — rejected/withdrawn purged after **90 days**, approved kept tenancy + **6 years**; (4) TFML/OEA feature split via the **B9 per-org feature-flag registry** (shared: work-order media, inspections, expense tracking, reporting; OEA-only: applications, leases, rent, landlord dashboards, marketing). Designs: `docs/OEA_TENANT_ONBOARDING.md`, `docs/RECONCILED_ROADMAP.md` (OEA section).

- **Foundation — POC/Demo (28 days):** all six modules on free/low-cost managed tiers; WhatsApp + Telegram intake; **synthetic/sample demo data** (no live client data). Exit gate: the `RECONCILED_ROADMAP.md` weekly milestones met and board approval.
- **Expansion — Phase 1 Production (on POC success):** full vendor lifecycle, SC billing/collection, remittance, governance reports, audit, BI; cloud-native zero self-hosting; production tiers. ~8–10 weeks.
- **Phase 2:** IoT-driven energy/predictive maintenance (Shelly EM smart meters), Aidra reporting pilot, deeper analytics.
- **Phase 3:** scale to 100+ facilities, predictive-maintenance AI at scale, autonomous specialised sub-agents, full enterprise BI.

### B6. Execution Rules
Build order = the Part C workflow. Keep Phase-2/3 seams in the schema from Day 1 (IoT tables, ML feature store stubs). Deliver each step behind a demo. Treat the two apportionment samples and the AURA workflows as the source of truth for SC and vendor logic.

### B7. Role × Report Access Matrix (RBAC — implemented in Step 2 & Module 6)
Real-time performance data is streamlined to each role's privilege. This matrix is the direct spec for the Step 2 Row-Level Security rules and the Module 6 dashboard views (RT = real-time):

| Role / human node | Service requests | SC & financials | Vendor scores & payments | Job cards / SLA | Exec / BI dashboard | Audit trail |
|---|---|---|---|---|---|---|
| Tenant / Occupant | Own (RT) | Own SC statement (RT) | — | — | — | — |
| Vendor | Assigned jobs (RT) | — | Own scorecard + pay status (RT) | Own (RT) | — | Own actions |
| FM Ops Staff | Assigned (RT) | — | — | Own dispatched (RT) | — | Own actions |
| Facility Manager | Assigned properties (RT) | Operational budgets (RT) | Managed vendors (RT) | All ops (RT) | Ops KPIs (RT) | Own scope |
| Properties Manager *(v3.5)* | Assigned properties (RT) | Operational budgets (RT) | Managed vendors (RT) | All ops (RT) | Ops KPIs (RT) | Own scope |
| Finance / Approver | **Only at their desk** (RT) *(v3.5)* | All (RT) | All + approve payouts (RT) | — | Financial (RT) | All financial |
| Property Owner | Own props summary (RT) | Own portfolio (RT + monthly report) | Own props (RT) | — | Own portfolio (RT) | Own props |
| Admin | All (RT) | All (RT) | All (RT) | All (RT) | All (RT) | All + config approvers/limits |
| Regional Manager *(v3.3)* | Assigned region/project (RT) | — | Managed vendors (RT) | All ops in region (RT) | Ops KPIs (RT) | Own scope |
| Executive — MD / Managing Partner *(v3.3)* | All (RT) | All (RT) | All + **approve** payouts (RT) | All (RT) | All (RT) | All |
| Payment Auditor *(v3.5)* | All (RT) | — | Payments at stage 2 (RT) | — | — | Own actions |
| Payment Approver *(v3.5)* | **Only at their desk** (RT) | — | Payments at stage 3 (RT) | — | — | Own actions |

Enforced at four layers (routing · Auth JWT claims · database RLS · API middleware) and across orgs (TFML / OEA / SC client). Admin configures approver hierarchy and thresholds.

**Request scoping (v3.5):** every role sees only the requests specifically theirs — raised by them, dispatched to them, or their company's. FM/PM/regional managers additionally see their managed places (triage depends on it); payment roles see a request only once money attached to it reaches their desk; org-wide sight is `admin`, `executive`, `payment_audit_approver` alone. See decision 19.

**Place scoping (v3.3):** "assigned properties" now means *directly assigned, plus everything beneath any hierarchy node assigned to you* — resolved by `current_user_property_ids()`, so a property added to a region later needs no re-assignment. **An executive does not execute remittances** (decision 9): the "approve payouts" cell above is approval only.

### B8. Notification Channels & Fallback Cascade (implemented in Step 3)
Five channels, one delivery engine (n8n-orchestrated), with an explicit failure cascade:

| Channel | Primary use | Status |
|---|---|---|
| WhatsApp Business API | Primary channel — all roles | Core |
| SMS (Africa's Talking) | Delivery-failure fallback | Core |
| Email (Resend) | Invoices, statements, remittance advice | Core |
| Push (PWA) | In-portal real-time alerts | Core |
| Telegram | Optional vendor channel (opt-in) | New |

**Fallback cascade (critical notifications):** WhatsApp → *(undelivered within threshold)* SMS → *(still undelivered)* Email. Push is shown in-portal to logged-in users regardless of the cascade. Telegram runs in **parallel** for vendors who opt in. Per-message delivery status is tracked and every retry/failover is written to the audit trail (Module 5).

### B9. Forward-Compatibility Provisions (built into Phase 1 — deferred modules added later without re-architecture)
The current build deliberately leaves seams so HR, document management, IoT/predictive maintenance and ERP/Azure integration can be switched on in later phases with no structural change:
- **Module registry + per-org feature flags** — HR and Document Management activate as new modules without touching existing ones.
- **Data-model seams from Day 1** — `staff/people`, `documents`, `assets`, `meters`, `sensor_readings`, `ml_features` table stubs, all under `org_id` multi-tenancy.
- **Document Management** reuses the existing Cloudflare R2 storage + metadata layer (already used for evidence/invoices) — extends to a full DMS later.
- **HR** extends the existing RBAC + people model (staff roles already defined).
- **IoT / Predictive Maintenance (Phase 2)** — asset/meter/sensor tables + an ML feature-store seam are already stubbed.
- **ERP / Azure AI** — API-first design + n8n connectors let an external ERP or Azure AI attach later without core changes.

---

## PART C — STEP-BY-STEP PROJECT DESIGN WORKFLOW (with tools)

> This is the canonical build sequence; the cost spreadsheet is organised against exactly these steps.

**Step 0 — Discovery, Data Audit & Solution Design.** Confirm SC client scope, map existing AURA + OEA SC journeys, inventory data sources, define the multi-tenant model and success metrics. *Tools:* Miro, existing AURA/OEA docs, the SC & electricity-apportionment samples, Supabase project scaffold.

**Step 1 — Cloud Foundation & DevSecOps.** Register domains + DNS/SSL, provision accounts, set up repo, secrets vault, CI/CD, error tracking, uptime monitoring. *Tools:* GitHub, Vercel, Cloudflare, Infisical, Sentry, Better Uptime.

**Step 2 — Core Data Model & Multi-Tenant Security.** Postgres schema for all 6 modules; row-level security enforcing `org_id`; Auth + RBAC roles (resident, vendor, PM, finance, approver, owner, admin) implementing the B7 Role × Report Access Matrix. **Org onboarding provision:** each org record carries a nullable `parent_org_id` and a `delivery_brand` field (TFML / OEA / direct) — so a new client (e.g. the SC client) can onboard either as an independent isolated org, or nested under a brand, or as an isolated org *associated* to one or both delivery brands (recommended). Funds/ledger isolation applies in all patterns. *Tools:* Supabase (Postgres + RLS + Auth).

**Step 3 — Omnichannel Intake & AI Triage.** WhatsApp Cloud API onboarding + template approval; Claude classifier (intent → module/route), n8n flows, SMS/email fallback, bias audit. Notification delivery covers all five channels with the B8 fallback cascade. *Tools:* WhatsApp Cloud API, Claude API, Gemini fallback, n8n, Africa's Talking (SMS), Resend (email), Telegram Bot API (vendor opt-in), Web Push (PWA).

**Step 4 — Resident/Tenant Portal (Module 1).** Request/complaint logging with photo/video evidence, ticket IDs + timestamps, SC statements, payment history, feedback/ratings, notifications, PWA offline. *Tools:* Next.js, Tailwind, shadcn/ui, Cloudflare R2.

**Step 5 — Vendor Management & Evaluation (Module 2).** Vendor registration/onboarding, contracts, allocation, KPI scoring engine (weighted per AURA), scorecards, monthly ranking, payment-eligibility status. *Tools:* Next.js, Supabase, custom scoring engine.

**Step 6 — Service Charge Administration & Billing (Module 3).** Annual budgets, apportionment engine (mirroring the sample SC and electricity workbooks), automatic invoicing, partial/full payments, arrears tracking, reconciliation, statements. *Tools:* Paystack, Flutterwave, @react-pdf/renderer, apportionment logic.

**Step 7 — Vendor Payment Administration & Remittance (Module 4).** Vendor invoice submission, verification + performance gates, payment recommendation, approval workflow, automated remittance, remittance advice. *Tools:* Paystack Transfers API, n8n, approval-workflow engine.

**Step 8 — Audit, Compliance & Governance (Module 5).** Immutable audit trail, activity/approval/payment history, NDPA/GDPR controls, compliance report generation, DPO/DPA documentation. *Tools:* Supabase audit tables, Claude report drafting, legal counsel.

**Step 9 — BI Dashboard & Reporting (Module 6).** Executive dashboard (open/closed requests, collection rate, receivables, vendor liabilities, budget utilisation), KPI widgets, financial/operational/governance reports, NL querying. *Tools:* Recharts in-app BI, optional Metabase Cloud, @react-pdf/renderer.

**Step 10 — Security Audit, UAT, Training & Go-Live.** Automated + manual pen-test, load test, multi-role UAT, staff training (TFML + OEA), user guides, production deploy. *Tools:* OWASP ZAP, k6, Nigerian security firm, training materials.

**Cross-cutting:** Legal & Compliance (DPA, privacy, WABA review) and Project Management/QA run across all steps.

---

### Questions for Management (to finalise scope, cost, and timeline)
1. **The new SC client:** how many properties/units and vendors are in the initial remittance scope, and what is the monthly SC billing and remittance volume?
2. **Remittance authority:** does OE Group hold/route client funds (custodial) or only instruct payments? This changes the licensing, controls, and gateway setup materially.
3. **Approval hierarchy:** who are the named approvers and what are the payment thresholds/limits per tier?
4. **Currency:** are any tenants/vendors invoiced in USD/GBP/EUR (drives Flutterwave scope), or Naira-only?
5. **Build resourcing:** in-house lead + external specialist (recommended, LOW column) or full external team (HIGH column)?
6. **BI depth:** is in-app Recharts sufficient for Phase 1, or is Metabase Cloud required for finance-grade analytics from day one?
7. **Aidra:** confirm whether Aidra is a Phase-1 requirement or a Phase-2 reporting pilot (currently scoped as Phase 2).
