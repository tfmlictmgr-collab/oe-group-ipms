// The process catalogue — the training handbook's actual content.
//
// `content.ts` answers "what does MY role let me do", written for the person
// doing the job. This answers a different question: "how does a whole journey
// run, who touches it at each step, and what does DONE look like" — written
// for whoever trains that person. One process is written once here and a
// role's chapter is a FILTER over this array, never a second copy of the same
// steps in different words — two hand-maintained accounts of the same journey
// always drift, exactly as `content.ts`'s own header already argues.
//
// ⚠️ Every process carries its own coverage anchors (`roles`, `capabilities`,
// `routes`) so `scripts/verify-training-guide.mjs` can ask the LIVE database
// which roles/capabilities/routes exist and fail when one of them has nothing
// here describing it — 0185's rule, written against the rule rather than
// against today's diff. Add a role, a capability, a screen: the build goes red
// until a process names it, not until someone remembers to update a manual.

export type ProcessStep = {
  /** The role performing this step, using the same key as `user_role`. Use
   * "system" for an automated step (AI triage, a scheduled job, a webhook) —
   * decision 10 requires that the automation's role in the journey is stated,
   * never quietly folded into a human step. */
  role: string;
  /** The screen and the button, in the words that role sees on their own UI. */
  action: string;
};

export type ProcessRefusal = {
  /** What the trainee tried, or asked why they cannot do. */
  trigger: string;
  /** Why the refusal is the control working, not a fault — named against the
   * decision it enforces wherever one exists, so a trainer can point at the
   * rule rather than assert it. */
  explanation: string;
};

export type TrainerNotes = {
  /** What to actually click, live, in front of the room. */
  demo: string;
  /** The mistake this journey most often produces, if any. */
  commonMistake?: string;
  /** A hands-on exercise against the seeded demo org — never a live TFML/OEA
   * org, so practice never lands a row in a real audit trail. */
  exercise: string;
};

export type Process = {
  /** Stable kebab-case id — referenced by URL, PDF job-aid filename, and deck
   * slide anchor, so it must not be renamed once published. */
  id: string;
  title: string;
  /** Groups processes in the catalogue and in the nav-style menu of the
   * training screen. Matches the module names capabilities already use. */
  module: string;
  /** The first touch point — what actually starts this journey. */
  startsWhen: string;
  steps: ProcessStep[];
  /** The concrete end state, and where to go look for it. */
  doneMeans: string;
  refusals?: ProcessRefusal[];
  trainer: TrainerNotes;
  /** True only for a process belonging to the platform operator's own job —
   * provisioning an org, editing the permission matrix, the cross-org
   * directory. Appears ONLY in the operator edition, never TFML's or OEA's:
   * B1's "or existence" applies to training material exactly as it applies to
   * the product. */
  operatorOnly?: boolean;
  /** A B9 module key (e.g. "lettings") gating this process to orgs that have
   * it contracted. Omit for a process every org gets. Never hand-list which
   * orgs get it — read from `org_modules`, same rule as `org_has_module()`. */
  requiresFeature?: string;
  /** `capabilities.key` values this journey exercises. Coverage anchor. */
  capabilities: string[];
  /** Dashboard routes this journey walks through. Coverage anchor. */
  routes: string[];
  /** Every role this journey is written for — a step's role plus any role
   * that merely receives an outcome (e.g. a tenant reading a closed ticket). */
  roles: string[];
};

export type Edition = "TFML" | "OEA" | "operator";

export const PROCESS_CATALOGUE: Process[] = [
  {
    id: "request-raise-resolve",
    title: "Raise a request and see it through to close",
    module: "Requests",
    startsWhen:
      "A tenant reports a problem — over WhatsApp, or the portal's " +
      "\"Submit Request\" button.",
    steps: [
      {
        role: "tenant",
        action:
          "WhatsApp, or My Requests → Submit Request. Describe the problem in " +
          "plain words — no category to pick. A photo settles most questions " +
          "before anyone visits.",
      },
      {
        role: "system",
        action:
          "AI triage reads the message and routes it to the right category and " +
          "desk. It classifies and routes; it never decides, scores or ranks " +
          "anything about the tenant (decision 10).",
      },
      {
        role: "facility_manager",
        action:
          "Requests (their own, or the property-scoped \"unassigned on my " +
          "buildings\" view). They review before dispatching to a vendor or to " +
          "an ops-staff member — the review-before-dispatch gate exists because " +
          "triage gets the category right, not always the right contractor.",
      },
      {
        role: "vendor",
        action:
          "My Work → the job. Update status as work proceeds and attach an " +
          "evidence photo on completion. (An internal ops-staff member does the " +
          "same from My Jobs when the work is dispatched in-house.)",
      },
      {
        role: "facility_manager",
        action:
          "Requests → confirm the evidence, then Close. This is also the " +
          "moment that feeds the vendor's scorecard.",
      },
      {
        role: "tenant",
        action:
          "My Requests shows it Closed, with the evidence attached, and offers " +
          "feedback/rating.",
      },
    ],
    doneMeans:
      "The ticket reads Closed in the tenant's My Requests with completion " +
      "evidence attached. If a vendor did the work, it now counts toward their " +
      "performance score.",
    refusals: [
      {
        trigger:
          "A property owner asks why they cannot see every complaint raised " +
          "about a building they own.",
        explanation:
          "They see only requests they raised themselves, plus their own " +
          "payments — decision 19. Seeing the whole operational queue was never " +
          "policy; it was a leak through a resolver that (correctly) does not " +
          "filter on ownership, and it has been closed.",
      },
      {
        trigger:
          "The payment officer asks why a request isn't on their dashboard.",
        explanation:
          "A payment role sees a request once money attached to it has entered " +
          "the approval chain — a vendor invoice OR an FM/PM's ops requisition " +
          "— never the operational queue itself (decisions 19 and 23). If they " +
          "see nothing at all, the usual cause is that no payable has been " +
          "raised against that request yet: the job sign-off is what starts " +
          "the chain.",
      },
      {
        trigger:
          "An FM tries to dispatch straight to a vendor without reviewing it " +
          "first, and it is refused.",
        explanation:
          "Review-before-dispatch (0178) is on by default — a request nobody " +
          "operational has looked at cannot be assigned. The platform operator " +
          "can grant `tickets.assign_without_review` per org for a genuinely " +
          "urgent-escalation workflow, but it ships off, deliberately: the " +
          "usual answer is to review it, not to switch the gate off. Separately, " +
          "an ADMINISTRATOR may dispatch a request that has sat unreviewed and " +
          "unassigned for more than 24 hours (decision 23) — a per-ticket, " +
          "time-bounded rescue that records them as the reviewer, not a standing " +
          "permission.",
      },
    ],
    trainer: {
      demo:
        "Raise a request as the demo tenant on WhatsApp and watch it land in " +
        "the FM's Requests within seconds — this single moment sells AI triage " +
        "better than any slide.",
      commonMistake:
        "New FMs dispatch on triage's category alone without opening the " +
        "photo first, then send the wrong trade.",
      exercise:
        "In the demo org: sign in as the demo tenant and raise a leaking-tap " +
        "request with a photo; switch to the demo FM and dispatch it to the " +
        "demo vendor; switch to the vendor and mark it complete with an " +
        "evidence photo; switch back to the FM and close it.",
    },
    capabilities: [
      "tickets.read_all",
      "tickets.assign",
      "tickets.close",
      "tickets.triage_unassigned",
      "tickets.assign_without_review",
    ],
    routes: [
      "/dashboard",
      "/dashboard/my-requests",
      "/dashboard/my-work",
      "/dashboard/my-jobs",
    ],
    roles: [
      "tenant",
      "facility_manager",
      "property_manager",
      "vendor",
      "fm_ops_staff",
    ],
  },
  {
    id: "vendor-payment-remittance",
    title: "From a vendor's invoice to money in their account",
    module: "Payments",
    startsWhen:
      "A vendor submits an invoice for completed work — My Company → Submit " +
      "Invoice, referencing the job card.",
    steps: [
      {
        role: "vendor",
        action:
          "My Company → Submit Invoice, attaching the job card it is for and " +
          "any evidence.",
      },
      {
        role: "facility_manager",
        action:
          "Payments → the invoice → Sign off, confirming the job or the period " +
          "is actually done. (Property manager, identically.) On TFML this is " +
          "stage 1 of the ladder; on OEA it is the PRECONDITION that starts the " +
          "ladder rather than a rung of it (decision 23) — either way it is the " +
          "same act, and nothing moves until it happens.",
      },
      {
        role: "payment_audit_approver",
        action:
          "Audit — checking the invoice against the job card and the evidence " +
          "attached to it. Stage 2 on TFML, stage 1 on OEA.",
      },
      {
        role: "executive",
        action:
          "OEA only: stage 2, the Managing Partner. EVERY outbound payment " +
          "passes them, at every amount — not only those above the threshold " +
          "(decision 23, amending decision 9). On TFML the executive instead " +
          "sits at stage 3 as a tier-3 approver.",
      },
      {
        role: "payment_approver",
        action:
          "Final approval, bounded by amount. Approvals → approve, up to the " +
          "band this person was invited with. On OEA they are the ONLY role at " +
          "this stage, so the organisation needs one whose tier covers its " +
          "largest payment; on TFML an executive (tier 3) can stand in. An " +
          "administrator can do neither — decision 23 removed them from money " +
          "approval entirely.",
      },
      {
        role: "finance_approver",
        action:
          "Disbursement only — never an approval. Payments → Remit. This must " +
          "be a different person from whoever actioned any earlier stage on " +
          "this same payment (decision 16; enforced per payment, not per role). " +
          "The screen records who actually executed it.",
      },
      {
        role: "vendor",
        action: "My Company shows the invoice as Paid, with the remittance date.",
      },
    ],
    doneMeans:
      "Payment status reads Remitted in both the vendor's My Company and the " +
      "org's Payments screen; the client-funds ledger reflects it and the next " +
      "daily bank reconciliation matches it.",
    refusals: [
      {
        trigger:
          "Someone who already actioned an earlier stage on this payment " +
          "tries to action a later one too.",
        explanation:
          "Refused outright — \"one human, one stage\" (0151). Holding two of " +
          "the roles involved does not let a person climb the chain twice on " +
          "the same payment; it needs a second pair of hands, and that refusal " +
          "is the control working, not a fault to route around.",
      },
      {
        trigger: "An administrator tries to approve a payment at any amount.",
        explanation:
          "Refused. Decision 23 removed the administrator from money approval " +
          "on both ladders — they hold no approval tier at all, where decision " +
          "16 had given them tier 2 within the threshold. They still configure " +
          "the organisation, and the ladder's amounts have been operator-" +
          "governed since 0149 regardless. They also cannot release money: only " +
          "the payment officer executes a remittance.",
      },
      {
        trigger: "An executive tries to execute a remittance.",
        explanation:
          "Decision 9: oversight authorises, the payment officer disburses. An " +
          "executive approves — on OEA, every payment — and can never reach " +
          "disbursement.",
      },
      {
        trigger: "Someone tries to skip straight to a later stage.",
        explanation:
          "Every earlier stage must be approved first — no skipping. An " +
          "upward edit to the amount after stage 3 also invalidates the chain " +
          "so far, so \"approve small, pay large\" cannot happen by editing " +
          "after the fact.",
      },
    ],
    trainer: {
      demo:
        "Show the chain refusing the same person a second stage on one " +
        "payment, live — this single refusal explains decision 16 and 0151 " +
        "faster than any amount of talking about maker-checker.",
      commonMistake:
        "Trainees assume \"admin\" is the most powerful role in the room and " +
        "expect it to be able to pay a vendor directly — worth walking through " +
        "why that is deliberate, not a gap.",
      exercise:
        "In the demo org, using different demo logins: as the demo vendor, " +
        "submit an invoice against a closed job card; as the demo FM, sign it " +
        "off; as the demo payment auditor, audit it; on OEA, as the demo " +
        "executive, give the Managing Partner's approval; as the demo payment " +
        "approver, approve it; as the demo payment officer, remit it.",
    },
    capabilities: ["payment.approve", "payment.remit"],
    routes: [
      "/dashboard/my-company",
      "/dashboard/approvals",
      "/dashboard/payments",
      "/dashboard/ledger",
    ],
    roles: [
      "vendor",
      "facility_manager",
      "property_manager",
      "payment_audit_approver",
      "payment_approver",
      "finance_approver",
      "admin",
      "executive",
    ],
  },
  {
    id: "file-a-property-and-its-units",
    title: "Build your property tree and file a new building",
    module: "Properties",
    startsWhen:
      "A new building needs to be on the system — the first one in a city, or " +
      "the fiftieth.",
    steps: [
      {
        role: "facility_manager",
        action:
          "Properties → Add Property. Create the region, location, project or " +
          "site inline, right there on the form, if it does not exist yet — a " +
          "picker that can only select is a dead end for the first property in " +
          "a new city. (Property manager, regional manager, or admin, " +
          "identically — whoever holds `hierarchy.write`.)",
      },
      {
        role: "facility_manager",
        action:
          "Record each unit's occupied floor area in square metres — this is " +
          "what decides its share of a service-charge budget later. State how " +
          "many identical units a row stands for (e.g. \"12 stalls\"); a " +
          "numbered row is created for each one, so every unit stays " +
          "individually invoiceable and lettable.",
      },
      {
        role: "facility_manager",
        action:
          "Open the property → \"Who is attached to this property\" and add " +
          "the people who manage it. This is not a label — it is the actual " +
          "access grant; someone not attached here cannot see this property " +
          "at all.",
      },
      {
        role: "facility_manager",
        action:
          "Once a tenancy starts, assign the occupant to their unit from the " +
          "Units panel. A unit is vacant only when it has no occupant AND no " +
          "live tenancy covering today (decision 22) — both conditions, read " +
          "the same way everywhere they matter.",
      },
    ],
    doneMeans:
      "The property appears in Properties/Portfolio with an accurate unit " +
      "count and vacancy count, every unit carries a floor area, and it is " +
      "ready to be budgeted and let.",
    refusals: [
      {
        trigger:
          "Someone without `hierarchy.write` tries to create a new location, " +
          "project or site while filing a property.",
        explanation:
          "They see a picker that can only select from what already exists — " +
          "ask an administrator to add the place, or to grant the capability " +
          "if this is a routine part of the job.",
      },
    ],
    trainer: {
      demo:
        "File a property in a city nobody has used before, entirely inline, " +
        "to show the tree is built AS you work rather than upfront.",
      commonMistake:
        "Filing units without recording their floor area — the property " +
        "looks complete but silently cannot be invoiced later.",
      exercise:
        "In the demo org: file a property under a brand-new location, add " +
        "three units with floor areas (one row standing for two of them), and " +
        "attach the demo FM to it.",
    },
    capabilities: [
      "hierarchy.write",
      "properties.write",
      "properties.read_all",
      "units.assign_occupant",
    ],
    routes: ["/dashboard/properties"],
    roles: ["admin", "facility_manager", "property_manager", "regional_manager"],
  },
  {
    id: "asset-register-and-servicing",
    title: "Keep the asset register, and service plant by running hours",
    module: "Assets",
    startsWhen:
      "A new asset — a generator, a lift, a pump — needs to be on the " +
      "register, or an existing one needs a service logged.",
    steps: [
      {
        role: "facility_manager",
        action:
          "Assets → Add Asset. State its scope — unit, property, or site — as " +
          "a fact, never left blank to mean \"shared\": a blank scope is read " +
          "as absent data, not as shared, and will not appear where a shared " +
          "asset should.",
      },
      {
        role: "facility_manager",
        action:
          "For plant serviced by usage rather than the calendar, record the " +
          "running-hours interval, then log a meter reading at every visit — " +
          "Assets → the asset → Log Reading.",
      },
      {
        role: "admin",
        action:
          "For a large or newly-onboarded portfolio, Assets → Import a " +
          "spreadsheet rather than entering assets one at a time.",
      },
      {
        role: "system",
        action:
          "The register flags an asset as due once its hours or calendar " +
          "interval is reached. Nothing raises a work order automatically — a " +
          "person still decides to raise the job.",
      },
    ],
    doneMeans:
      "The asset register shows an accurate scope and a correct hours- or " +
      "days-remaining figure for every listed asset.",
    refusals: [
      {
        trigger:
          "Logging a running-hours reading lower than the last one is " +
          "refused.",
        explanation:
          "This is the typo guard (decision 21): a lower reading would " +
          "otherwise mark a working machine permanently overdue. If the meter " +
          "itself was genuinely replaced, declare that explicitly rather than " +
          "working around the refusal.",
      },
    ],
    trainer: {
      demo:
        "Log a generator's running hours twice, ascending, and show the " +
        "due-soon flag appear as it approaches its interval.",
      commonMistake:
        "Leaving an asset's scope blank on the assumption that \"shared\" is " +
        "the default — it is not; shared has to be stated.",
      exercise:
        "In the demo org: add an asset scoped to the whole site, log two " +
        "ascending hour readings, then try logging a lower one and read the " +
        "refusal.",
    },
    capabilities: ["assets.read", "assets.write", "assets.import"],
    routes: ["/dashboard/assets"],
    roles: ["admin", "facility_manager", "property_manager", "regional_manager"],
  },
  {
    id: "vendor-registration-and-evaluation",
    title: "Register a vendor, attach them to work, and evaluate them",
    module: "Vendors",
    startsWhen:
      "A contractor needs to start working on a property — cleaning, " +
      "security, a trade.",
    steps: [
      {
        role: "vendor",
        action:
          "Registers themselves, or is added by an administrator or FM. " +
          "Standard or enhanced checks are set by the managing organisation, " +
          "depending on how much scrutiny the work needs.",
      },
      {
        role: "facility_manager",
        action:
          "Vendors → Registrations, reviews the pack and its documents, and " +
          "approves it or asks for more.",
      },
      {
        role: "facility_manager",
        action:
          "Attaches the vendor to the properties they actually work on.",
      },
      {
        role: "facility_manager",
        action:
          "After a job closes, submits a performance evaluation — quality, " +
          "response time, completion time, satisfaction, compliance — the " +
          "weighted scorecard behind the payment gate (30/20/20/20/10).",
      },
      {
        role: "vendor",
        action: "My Company shows their own scorecard and payment-eligibility status.",
      },
    ],
    doneMeans:
      "The vendor shows Verified with an up-to-date scorecard; a vendor below " +
      "the performance bar is stopped automatically at the payment gate " +
      "described in \"From a vendor's invoice to money in their account\".",
    refusals: [
      {
        trigger: "A vendor asks to see another vendor's scorecard or evidence.",
        explanation: "Every vendor sees only their own jobs, score and pay status.",
      },
      {
        trigger:
          "Someone looks for a way to pay a vendor straight from their " +
          "registered bank details.",
        explanation:
          "There is none. Registration states and evidences bank details — " +
          "last four digits plus the bank's own document — and finance " +
          "registers the actual payout recipient separately. No path exists " +
          "from registration into a payable account (decision 17).",
      },
    ],
    trainer: {
      demo: "Walk the registrations queue, then submit one evaluation form.",
      commonMistake:
        "Attaching a vendor to a property and never evaluating their work — " +
        "they then can never clear the payment gate, and the reason looks " +
        "like a bug until you check.",
      exercise:
        "As the demo FM: approve the demo vendor's registration, attach them " +
        "to a demo property, and evaluate one of their closed jobs.",
    },
    capabilities: ["vendors.read", "vendors.write", "vendors.evaluate"],
    routes: ["/dashboard/vendors", "/dashboard/vendors/registrations"],
    roles: [
      "admin",
      "facility_manager",
      "property_manager",
      "regional_manager",
      "vendor",
    ],
  },
  {
    id: "service-charge-budget-to-collection",
    title: "Build a service-charge budget, collect it, and report to the owner",
    module: "Service charge",
    startsWhen:
      "A new billing period opens for a property, or an owner asks how " +
      "collection is going.",
    steps: [
      {
        role: "facility_manager",
        action: "Service Charges → New Budget for the period, and add the line items.",
      },
      {
        role: "system",
        action:
          "Apportions the budget across units by occupied floor area and " +
          "generates a branded per-unit invoice.",
      },
      {
        role: "tenant",
        action:
          "Receives the invoice (WhatsApp, portal or email) and pays through " +
          "the checkout link. My Requests → Statements shows the running " +
          "balance.",
      },
      {
        role: "system",
        action:
          "A webhook-verified payment updates the ledger and issues a receipt " +
          "in real time.",
      },
      {
        role: "facility_manager",
        action: "Service Charges → Arrears to see who has not paid, and follow up.",
      },
      {
        role: "property_owner",
        action:
          "Portfolio and Statements show their own buildings' collection and " +
          "a monthly report — never another owner's building, and never the " +
          "operational request detail behind it.",
      },
    ],
    doneMeans:
      "The period's budget is fully apportioned and invoiced, and Statements " +
      "reconciles collected-versus-billed for both the FM and the owner's own " +
      "portfolio.",
    refusals: [
      {
        trigger: "A tenant asks to see the whole building's budget.",
        explanation: "They see only their own statement, never the budget behind it.",
      },
      {
        trigger:
          "An owner asks why their dashboard doesn't show the complaints " +
          "behind a charge.",
        explanation:
          "An owner's view is their portfolio and its money, not the " +
          "operational queue — see decision 19 in \"Raise a request and see " +
          "it through to close\".",
      },
    ],
    trainer: {
      demo: "Run one apportionment end to end on a small demo budget.",
      commonMistake:
        "Forgetting a unit's floor area when filing the property — it " +
        "silently drops that unit out of the apportionment.",
      exercise:
        "As demo admin: create a small SC budget on the demo property and " +
        "confirm the two demo units are invoiced proportionally to their area.",
    },
    capabilities: ["sc.manage", "sc.read_all"],
    routes: ["/dashboard/sc", "/dashboard/statements", "/dashboard/portfolio"],
    roles: ["admin", "facility_manager", "property_manager", "tenant", "property_owner"],
  },
  {
    id: "tenancy-application-to-lease",
    title: "Take a tenancy from application to an active lease",
    module: "Lettings",
    startsWhen:
      "A prospective tenant applies through a property's own link, which " +
      "carries that property's identity with it.",
    requiresFeature: "lettings",
    steps: [
      {
        role: "tenant",
        action:
          "Applies through the property's own link — Apply → fills the form " +
          "and uploads identity and income documents.",
      },
      {
        role: "property_manager",
        action:
          "Reviewer one. Leases → Applications, reviews the pack, records " +
          "their own stated reason, and recommends or declines. Screening is " +
          "always human — never automated (decision 10).",
      },
      {
        role: "regional_manager",
        action:
          "Reviewer two — a different person from reviewer one. Reviews " +
          "independently and approves or declines.",
      },
      {
        role: "property_manager",
        action:
          "On approval, Leases → Create Lease, and assigns the occupant to " +
          "the unit — this is what actually clears \"vacant\" (decision 22).",
      },
      {
        role: "system",
        action:
          "Rent is billed annually in advance on the org's configured cadence; " +
          "renewal notices fire at 90, 60 and 30 days before the tenancy ends, " +
          "once per threshold, never repeating.",
      },
      {
        role: "property_manager",
        action:
          "Leases → End Tenancy when it genuinely ends. Expiry alone never " +
          "vacates the unit — a person confirms the tenant has actually gone " +
          "before the unit is offered again.",
      },
    ],
    doneMeans:
      "The lease shows Active, the unit shows Occupied, and the tenant can " +
      "see the lease and their rent history on My Rent.",
    refusals: [
      {
        trigger: "The same person who recommended an application also approves it.",
        explanation:
          "Two-tier review means two people, not two clicks by one — get a " +
          "second, different reviewer.",
      },
      {
        trigger:
          "A tenant holds over past their lease's end date and someone " +
          "expects the unit to already show vacant.",
        explanation:
          "Expiry is arithmetic on a date; a person still has to confirm the " +
          "tenant has actually gone before the unit is marked vacant — a date " +
          "is not evidence of that (decision 22).",
      },
    ],
    trainer: {
      demo: "Run the two-tier review live with two different logins.",
      commonMistake:
        "One person double-hatting both review stages under two tabs — the " +
        "system does not block this at the UI, so training has to.",
      exercise:
        "In the demo org: submit a demo application, review it as the demo " +
        "property manager, approve it as the demo regional manager, then " +
        "create the lease.",
    },
    capabilities: [
      "applications.review_all",
      "applications.recommend",
      "applications.approve",
      "leases.write",
      "units.assign_occupant",
    ],
    routes: ["/dashboard/leases", "/dashboard/my-rent"],
    roles: [
      "tenant",
      "property_manager",
      "regional_manager",
      "admin",
      "property_owner",
    ],
  },
  {
    id: "automated-document-verification",
    title: "Automated document checks on a tenancy application",
    module: "Lettings",
    startsWhen: "A tenant submits an application with identity or income documents attached.",
    requiresFeature: "ai_document_checks",
    steps: [
      {
        role: "system",
        action:
          "Extracts and checks the uploaded documents — format, completeness, " +
          "duplicate detection — and records findings against the specific " +
          "document each came from.",
      },
      {
        role: "property_manager",
        action:
          "Sees the findings alongside the application, but still writes " +
          "their own stated reason for recommending or declining — a finding " +
          "is decision support, never a substitute for it (decision 10).",
      },
    ],
    doneMeans:
      "Every finding is traceable to the specific page it came from, and the " +
      "recorded decision carries the reviewer's own words, not the tool's " +
      "output copied in.",
    refusals: [
      {
        trigger: "Someone asks whether the tool can reject an application by itself.",
        explanation:
          "It cannot — it may only surface findings. Special-category data " +
          "(religion, marital status) is never sent to it at all; it stays in " +
          "the separate `sensitive` column.",
      },
    ],
    trainer: {
      demo: "Show a duplicate-ID finding attached to the exact page it came from.",
      commonMistake:
        "A reviewer copy-pasting the tool's finding as their own stated " +
        "reason — coach them to write an independent one.",
      exercise:
        "View a flagged demo application and write an independent reviewer " +
        "reason before recommending it.",
    },
    capabilities: ["applications.run_document_checks"],
    routes: ["/dashboard/leases"],
    roles: ["property_manager", "admin"],
  },
  {
    id: "invite-assign-offboard-people",
    title: "Invite people, assign them to places, and offboard them",
    module: "People",
    startsWhen: "Someone new needs access, or someone leaves.",
    steps: [
      {
        role: "admin",
        action:
          "People → Invite, choosing the narrowest role that lets the person " +
          "do their job. A regional manager may invite only operational staff " +
          "bounded to their own region — never an administrator; inviting an " +
          "admin is non-delegable and stays with the org's own administrator " +
          "(decision 7).",
      },
      {
        role: "tenant",
        action: "Accepts the emailed invitation and signs in with their own email.",
      },
      {
        role: "facility_manager",
        action:
          "Attaches the new person to the properties or region they need — " +
          "see \"Who is attached to this property\" in \"Build your property " +
          "tree and file a new building\".",
      },
      {
        role: "admin",
        action:
          "People → Deactivate the moment someone leaves. Access is removed " +
          "immediately; their record and everything they did stays, because " +
          "the audit trail is never rewritten. Never hand their login to a " +
          "replacement — invite the new person properly instead.",
      },
    ],
    doneMeans:
      "The new person can sign in and sees exactly their own scope; a " +
      "departed person cannot sign in at all, and their past actions remain " +
      "visible on the audit trail.",
    refusals: [
      {
        trigger: "A regional manager tries to invite an administrator.",
        explanation:
          "Refused. `invitation.create_admin` is non-delegable — only the " +
          "org's own administrator issues an admin invitation (decision 7).",
      },
    ],
    trainer: {
      demo: "Invite a person and accept the invitation live, end to end.",
      commonMistake:
        "Sharing a login with a replacement instead of inviting them properly " +
        "— it breaks the audit trail's attribution to a real person.",
      exercise:
        "Invite a demo ops-staff account, accept it, attach it to a demo " +
        "property, then deactivate it and confirm sign-in now fails.",
    },
    capabilities: ["people.invite", "people.deactivate", "invitation.create_admin"],
    routes: ["/dashboard/people"],
    roles: ["admin", "regional_manager"],
  },
  {
    id: "read-the-audit-trail",
    title: "Read the audit trail",
    module: "Governance",
    startsWhen: "Someone needs to trace who did what, and when.",
    steps: [
      {
        role: "admin",
        action: "Audit Trail → filter by person, property or date.",
      },
      {
        role: "payment_audit_approver",
        action:
          "Opens any payment entry to see every stage it climbed and who " +
          "actioned each one.",
      },
    ],
    doneMeans:
      "Any action anyone took in the org can be traced to a person, a time, " +
      "and — for a payment — every stage it climbed.",
    refusals: [
      {
        trigger:
          "An FM who actually did the work asks to see the org-wide audit " +
          "trail.",
        explanation:
          "Org-wide sight is exactly `admin`, `executive` and " +
          "`payment_audit_approver` — named once, not repeated as role " +
          "literals across the codebase. Everyone else sees their own actions " +
          "on their own screens, which is a different, narrower thing.",
      },
      {
        trigger: "Someone asks to correct or remove a mistaken audit entry.",
        explanation:
          "It cannot be done. The trail is append-only by design — an entry " +
          "that could be edited afterwards would not be evidence of anything.",
      },
    ],
    trainer: {
      demo:
        "Trace one payment from its invoice to its remittance through the " +
        "trail, stage by stage.",
      commonMistake:
        "Assuming a mistaken entry can be corrected in place — it cannot; a " +
        "correction is itself a new, separate entry.",
      exercise:
        "Find the demo remittance from the payment-chain exercise on the " +
        "Audit Trail and read its full stage history.",
    },
    capabilities: ["audit.read"],
    routes: ["/dashboard/audit"],
    roles: ["admin", "executive", "payment_audit_approver"],
  },
  {
    id: "reconcile-the-client-funds-ledger",
    title: "Reconcile the client-funds ledger daily",
    module: "Money",
    startsWhen: "Every day, once the bank statement is available.",
    steps: [
      {
        role: "finance_approver",
        action:
          "Client Funds → compares the system ledger against the bank " +
          "statement for the day.",
      },
      {
        role: "finance_approver",
        action:
          "Posts a correcting entry with a stated reason if there is a " +
          "genuine variance (a bank fee, for example) — never left " +
          "unexplained.",
      },
      {
        role: "admin",
        action: "Client Funds → reads the same ledger, read-only oversight.",
      },
    ],
    doneMeans:
      "The ledger balance matches the bank statement for the day, or every " +
      "variance carries a same-day, stated reason.",
    refusals: [
      {
        trigger: "An admin or executive tries to post a ledger entry.",
        explanation:
          "`ledger.write` belongs to finance alone — oversight roles read the " +
          "ledger; they do not write to it (decision 9's pattern, applied to " +
          "the ledger rather than a payment).",
      },
    ],
    trainer: {
      demo: "Walk one day's reconciliation, including a deliberately seeded variance.",
      commonMistake:
        "Treating a small mismatch as fine \"for now\" — every variance needs " +
        "a same-day reason logged, however small.",
      exercise:
        "As the demo payment officer: open Client Funds and identify the " +
        "seeded variance for the demo org.",
    },
    capabilities: ["ledger.read", "ledger.write"],
    routes: ["/dashboard/ledger"],
    roles: ["finance_approver", "admin", "executive"],
  },
  {
    id: "configure-banking-thresholds-channels",
    title: "Configure banking, approval thresholds, and channel credentials",
    module: "Settings",
    startsWhen: "An organisation is being set up, or a threshold needs to change.",
    steps: [
      {
        role: "admin",
        action:
          "Settings → Payments, sets who approves and up to what amount — the " +
          "payment_approver tiers and the admin's own tier-2 threshold.",
      },
      {
        role: "admin",
        action:
          "Settings → Banking, records the segregated client-funds account " +
          "the org disburses from. This configures the account; it never " +
          "moves money itself.",
      },
      {
        role: "admin",
        action:
          "Settings → Channels, sets the inbound WhatsApp/Telegram routing — " +
          "a locked, non-delegable control.",
      },
      {
        role: "admin",
        action:
          "Settings → Branding, sets the logo, colours and support contact " +
          "that appear on every PDF and on this org's own sign-in page.",
      },
    ],
    doneMeans:
      "Thresholds, banking and channel routing are set before go-live, and " +
      "branding appears correctly on the org's own sign-in and on generated " +
      "PDFs.",
    refusals: [
      {
        trigger: "An admin tries to raise their own approval threshold.",
        explanation:
          "They can see the permission matrix here but not edit it — only " +
          "the platform operator changes it (decision 7). An admin cannot " +
          "lift the limit they approve against.",
      },
    ],
    trainer: {
      demo:
        "Set a threshold and then show an invoice above it demand a tier-3 " +
        "approver — the executive on TFML, a tier-3 payment approver on OEA, " +
        "where the executive has already signed at stage 2 and cannot sign " +
        "twice.",
      commonMistake:
        "Treating `bank.configure` as a way to redirect where one specific " +
        "payment goes — it sets the org's own disbursement account, not a " +
        "transaction.",
      exercise:
        "In the demo org: set a ₦50,000 admin threshold and show a larger " +
        "demo invoice escalate to the demo executive.",
    },
    capabilities: ["bank.configure", "channel.credentials"],
    routes: ["/dashboard/settings"],
    roles: ["admin"],
  },
  {
    id: "read-only-observer-overview",
    title: "Review programme status as a read-only observer",
    module: "Overview",
    startsWhen: "An outside stakeholder needs to check on programme status.",
    steps: [
      {
        role: "viewer",
        action:
          "Signs in and lands on Programme Overview — the one screen this " +
          "role gets, deliberately, rather than degraded versions of several " +
          "operational ones.",
      },
    ],
    doneMeans:
      "The viewer can state the programme's current status to whoever asked " +
      "them to look, without touching anything.",
    refusals: [
      {
        trigger: "A viewer looks for Requests, Assets or any operational list.",
        explanation:
          "None of those appear. A single honest page beats four that would " +
          "half-work — a viewer has no policy on the tables behind them, so " +
          "they would render empty or wrong rather than refuse cleanly.",
      },
    ],
    trainer: {
      demo:
        "Show how sparse this role's own menu is next to an admin's, to make " +
        "\"read-only\" legible as a real, narrow thing.",
      exercise: "Sign in as the demo viewer and confirm no other nav item appears.",
    },
    capabilities: [],
    routes: ["/dashboard/overview"],
    roles: ["viewer"],
  },
  {
    id: "bi-dashboard-and-analytics",
    title: "Read the BI dashboard and drill into request analytics",
    module: "Reporting",
    startsWhen: "Someone needs this month's numbers, not a raw export.",
    steps: [
      {
        role: "admin",
        action:
          "Analytics → the executive dashboard: open/closed requests, " +
          "collection rate, receivables, vendor liabilities, budget " +
          "utilisation.",
      },
      {
        role: "admin",
        action:
          "Analytics Console → drills into request volumes, SLA performance " +
          "and vendor scores, or asks it a plain-language question.",
      },
      {
        role: "regional_manager",
        action:
          "Sees the same KPIs, narrowed to their own assigned region or " +
          "project — the same place-scoping Requests uses.",
      },
    ],
    doneMeans:
      "The reader can state this month's collection rate, request-closure " +
      "time, and any vendor below their KPI bar, without exporting anything.",
    refusals: [
      {
        trigger:
          "A regional manager's dashboard is expected to show figures " +
          "outside their region.",
        explanation:
          "It never does — \"nothing financial, no org-wide read\" is " +
          "decision 9's own description of this role.",
      },
    ],
    trainer: {
      demo: "Ask the console a plain-language question, live.",
      commonMistake:
        "Assuming \"RT\" means a live socket updating to the second — it " +
        "means near-real-time, worth clarifying up front.",
      exercise:
        "As the demo regional manager: confirm the dashboard shows only " +
        "their assigned region's numbers.",
    },
    capabilities: ["bi.read"],
    routes: ["/dashboard/bi", "/dashboard/bi/analytics"],
    roles: ["admin", "executive", "regional_manager"],
  },
  {
    id: "open-your-own-role-guide",
    title: "Open your own role guide, and train your team from the handbook",
    module: "Getting help",
    startsWhen: "Anyone signed in wants to know what their own role can do, or an admin needs to train someone else's.",
    steps: [
      {
        role: "tenant",
        action:
          "Guide, on the main menu — reads their own role's handbook on " +
          "screen, or \"Download as PDF\" for a branded copy to keep.",
      },
      {
        role: "admin",
        action:
          "Training, on the main menu — every process in this org, grouped " +
          "by role and by module, with a Trainer view (demo notes, common " +
          "mistakes, a practice exercise) and a Team view (steps only) for " +
          "handing to the person actually doing the job.",
      },
    ],
    doneMeans:
      "The reader can answer \"what can I do here\" without asking anyone; " +
      "an admin can run a training session straight from the same source the " +
      "screen itself is built from.",
    refusals: [
      {
        trigger:
          "An admin opens Training and sees \"Not turned on for your " +
          "organisation yet\".",
        explanation:
          "The handbook is a rollout switch, not a permission — it ships " +
          "off for every role in every organisation, admin included, and an " +
          "OE Group operator turns it on per organisation once that " +
          "organisation's own content has been reviewed (same shape as " +
          "`tickets.assign_without_review`, 0178). Ask OE Group, not your " +
          "own administrator settings.",
      },
    ],
    trainer: {
      demo:
        "Download your own role guide's PDF live, then switch Training to " +
        "Trainer view and show the same process with its demo notes attached.",
      exercise: "Download your own guide as whichever demo login you are currently using.",
    },
    capabilities: ["training.read"],
    routes: ["/dashboard/guide", "/dashboard/training"],
    roles: ["tenant", "vendor", "admin"],
  },
  {
    id: "operator-provision-organisation",
    title: "Provision a new organisation onto the platform",
    module: "Operator",
    operatorOnly: true,
    startsWhen: "A new client organisation is ready to be onboarded.",
    steps: [
      {
        role: "admin",
        action:
          "/orgs → New Organisation. Choose a unique slug (derived from the " +
          "name, not the delivery brand), the delivery brand, and the " +
          "starting B9 module flags.",
      },
      {
        role: "system",
        action:
          "Seeds the org's permission matrix from the board-approved " +
          "baseline (B7), and its own `/o/<slug>` sign-in.",
      },
      {
        role: "admin",
        action: "Invites that organisation's own first administrator.",
      },
    ],
    doneMeans:
      "The new org has a working `/o/<slug>` sign-in of its own, a seeded " +
      "matrix, and one administrator who can run everything else in this " +
      "handbook themselves from here.",
    refusals: [
      {
        trigger: "Two organisations derive the same slug from their name.",
        explanation:
          "The collision is refused before the org exists at all — slugs are " +
          "unique among live orgs, and this is resolved before onboarding " +
          "continues.",
      },
    ],
    trainer: {
      demo:
        "Show an existing seeded org's `/o/<slug>` sign-in and point out " +
        "what it does NOT reveal — no list of other orgs, no other brand.",
      commonMistake:
        "Deriving the slug from `delivery_brand` instead of the org's own " +
        "name — two orgs on the same brand collide immediately.",
      exercise:
        "Do not create a real organisation for practice. Instead review an " +
        "existing seeded org's `/o/<slug>` page and state, out loud, what it " +
        "does not disclose.",
    },
    capabilities: [],
    routes: ["/orgs"],
    roles: ["admin"],
  },
  {
    id: "operator-edit-permission-matrix",
    title: "Edit the permission matrix for a client organisation",
    module: "Operator",
    operatorOnly: true,
    startsWhen: "A client's access needs to change, or a drift from baseline needs review.",
    steps: [
      {
        role: "admin",
        action:
          "/orgs → the organisation → Permissions. Any deviation from the " +
          "B7 baseline is badged as a diff.",
      },
      {
        role: "admin",
        action: "Toggles a capability, or clicks \"reset to baseline\" to remove drift.",
      },
    ],
    doneMeans:
      "The org's matrix shows the intended state; drift badges are gone, or " +
      "deliberately kept where the deviation is intentional.",
    refusals: [
      {
        trigger: "A brand's own administrator tries to edit their org's matrix.",
        explanation:
          "They see it read-only. Only the platform operator edits it " +
          "(decision 7) — an org cannot widen its own access.",
      },
      {
        trigger: "A non-delegable capability is looked for as a toggle here.",
        explanation:
          "It never appears as one. Payment approval, remittance execution, " +
          "the ledger, banking, audit visibility, admin invitation and this " +
          "screen itself are hardwired, not preferences.",
      },
    ],
    trainer: {
      demo: "Show the diff badge and the one-click reset to baseline.",
      commonMistake:
        "Assuming a brand admin can reach this screen themselves — remind " +
        "trainees it is read-only for the org.",
      exercise:
        "View a seeded demo org's matrix and state whether it carries any " +
        "intentional deviation from baseline.",
    },
    capabilities: ["permissions.edit"],
    routes: ["/orgs"],
    roles: ["admin"],
  },
  {
    id: "operator-consolidated-view",
    title: "Review the consolidated cross-organisation view",
    module: "Operator",
    operatorOnly: true,
    startsWhen: "The operator needs platform-wide totals, not one org at a time.",
    steps: [
      {
        role: "admin",
        action:
          "/orgs/consolidated → aggregate figures across every organisation " +
          "on the platform, both brands.",
      },
    ],
    doneMeans: "Platform-wide totals can be stated without opening each org individually.",
    refusals: [
      {
        trigger: "A brand's own administrator tries to reach this screen.",
        explanation:
          "`caller_is_operator_admin()` is checked inside the query itself, " +
          "so anyone else gets an empty set rather than a refusal — a refusal " +
          "would confirm there was something worth refusing (decision 12).",
      },
    ],
    trainer: {
      demo: "Show the aggregate view, both brands represented without naming " +
        "either to the other's stakeholders.",
      exercise: "Review the operator's own consolidated screen with the operator's own login.",
    },
    capabilities: [],
    routes: ["/orgs/consolidated"],
    roles: ["admin"],
  },
];

/** The catalogue, narrowed to one edition. Never hand-maintained per edition —
 * derived from `operatorOnly` (B1) and `requiresFeature` (B9, read from the
 * org's own `org_modules`) so a new process is correctly placed by stating
 * what it needs, not by someone remembering which orgs it applies to. */
export function processesForEdition(
  edition: Edition,
  orgFeatures: ReadonlySet<string> = new Set()
): Process[] {
  return PROCESS_CATALOGUE.filter((p) => {
    if (edition === "operator") return !!p.operatorOnly;
    if (p.operatorOnly) return false;
    if (p.requiresFeature && !orgFeatures.has(p.requiresFeature)) return false;
    return true;
  });
}

/** One role's chapter: every process in the edition that gives this role a
 * step, in catalogue order. */
export function processesForRole(
  role: string,
  edition: Edition,
  orgFeatures?: ReadonlySet<string>
): Process[] {
  return processesForEdition(edition, orgFeatures).filter((p) =>
    p.roles.includes(role)
  );
}
