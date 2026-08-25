// What each role's guide actually says.
//
// Written for the person doing the job, not for the person who built it. A
// caretaker in Aba opening this on a phone at 7am needs to know which button
// raises a request — not what RLS is, not which migration added the screen, and
// not the word "capability". Every sentence here is meant to survive being read
// by someone who has never used the system and is slightly annoyed that they
// have to.
//
// ⚠️ These describe what a role CAN do, and B7 decides that. Where the two ever
// disagree, B7 and the permission matrix are right and this file is stale —
// a guide that promises a button the reader does not have is worse than no
// guide, because it sends them to support to ask for something they were never
// meant to have. Keep the "What you cannot do" section honest for that reason:
// it is the half that prevents the support call.

export type GuideStep = { title: string; body: string };

export type GuideSection = {
  heading: string;
  intro?: string;
  steps: GuideStep[];
};

export type RoleGuide = {
  /** Shown as the document's own title. */
  title: string;
  /** One line under the title — who this is for, in their own words. */
  audience: string;
  /** The two or three things this person does most days. */
  sections: GuideSection[];
  /** Stated plainly, so nobody raises a ticket asking for it. */
  cannot: string[];
};

// Shared endings. Repeating them per role would let them drift apart, and the
// answer to "who do I call" must not depend on which guide you opened.
const GETTING_HELP: GuideSection = {
  heading: "If something goes wrong",
  steps: [
    {
      title: "You forgot your password",
      body:
        "On the sign-in screen, tap \"Forgot password?\" and follow the email. " +
        "Nobody — including an administrator — can see or tell you your password; " +
        "they can only send you a fresh link.",
    },
    {
      title: "A screen says you cannot do something",
      body:
        "That is the system working, not breaking. What each role may reach is " +
        "set centrally and deliberately. If you genuinely need it for your job, " +
        "ask your administrator to review your access rather than working around it.",
    },
    {
      title: "A screen is empty when you expected rows",
      body:
        "You are usually seeing only what belongs to you — your properties, your " +
        "jobs, your requests. An empty list normally means nothing has been " +
        "assigned to you yet, not that anything is lost.",
    },
    {
      title: "You still need a person",
      body:
        "Use the support contact printed at the bottom of this guide. Quote the " +
        "reference number of whatever you were looking at — every request, " +
        "invoice and payment has one, and it saves a long conversation.",
    },
  ],
};

const SIGNING_IN: GuideSection = {
  heading: "Getting in",
  steps: [
    {
      title: "Use your own organisation's address",
      body:
        "Your organisation has its own sign-in page with its own name and colours " +
        "on it. Use the link you were sent and bookmark it. If a page shows a " +
        "different company's name, you are in the wrong place — do not sign in.",
    },
    {
      title: "Sign in with your work email",
      body:
        "The address your invitation was sent to. If you were never invited, no " +
        "account exists yet — ask your administrator to invite you rather than " +
        "trying to create one; there is no self-registration.",
    },
    {
      title: "Works on a phone",
      body:
        "The portal is built for a phone as much as a laptop, and it keeps working " +
        "on a weak connection. Add it to your home screen and it opens like an app.",
    },
  ],
};

/**
 * The guides, keyed by the role stored on the user's profile.
 *
 * `facility_manager` and `property_manager` are two roles that do the same job
 * in different disciplines (decision 18), so they share a body and differ only
 * in what they are called. The label is passed in rather than hardcoded,
 * because OEA calls one of them "Properties Manager".
 */
export const ROLE_GUIDES: Record<string, RoleGuide> = {
  tenant: {
    title: "Your resident portal",
    audience:
      "For residents and occupants — reporting problems, following them up, and " +
      "keeping on top of what you owe.",
    sections: [
      SIGNING_IN,
      {
        heading: "Reporting a problem",
        intro:
          "Anything that needs fixing — a leak, a failed generator, a broken lock. " +
          "You can do this from the portal or straight from WhatsApp.",
        steps: [
          {
            title: "From the portal",
            body:
              "Open \"My Requests\" and choose \"Submit Request\". Describe the problem " +
              "in your own words — you do not need to know which trade it belongs to, " +
              "the system works that out and sends it to the right desk.",
          },
          {
            title: "Add a photo",
            body:
              "A photo settles most questions before anyone visits. Attach one if you " +
              "can; it usually gets the job done faster than a longer description.",
          },
          {
            title: "From WhatsApp",
            body:
              "Message the number your organisation gave you and describe the problem " +
              "as you would to a person. You will get a reference number back. This is " +
              "the same request the office sees — it is not a separate queue.",
          },
          {
            title: "If it is an emergency",
            body:
              "For anything involving fire, gas, flooding or danger to a person, call " +
              "your building's emergency line first. A message is logged and answered " +
              "in working hours; it is not an alarm.",
          },
        ],
      },
      {
        heading: "Following it up",
        steps: [
          {
            title: "Check where it has got to",
            body:
              "\"My Requests\" lists everything you have reported and its current " +
              "state. You do not need to ring to ask for an update.",
          },
          {
            title: "Marking it urgent",
            body:
              "If something has become worse, mark it urgent. That raises its priority " +
              "and flags it for a person to look at — it is treated as a signal from " +
              "you, not as an automatic decision.",
          },
        ],
      },
      {
        heading: "Money",
        steps: [
          {
            title: "What you owe and what you have paid",
            body:
              "Your statement shows your service charge, your rent if you rent through " +
              "this organisation, what has been paid and what is outstanding. Every " +
              "payment you make appears here with a receipt you can download.",
          },
          {
            title: "Paying",
            body:
              "Pay from the portal by card or transfer. A receipt is issued " +
              "automatically and your statement updates — you never need to send " +
              "proof of payment separately.",
          },
          {
            title: "Why your share is what it is",
            body:
              "A service charge is one budget for the whole property, divided between " +
              "units by the floor area each one occupies. A larger unit pays a larger " +
              "share of the same pot. Your statement shows the working.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "See anyone else's requests, payments or statements — only your own.",
      "See other residents' names or contact details.",
      "Change what you are charged. If a charge looks wrong, raise it rather than waiting.",
    ],
  },

  vendor: {
    title: "Your contractor portal",
    audience:
      "For contractors and service providers — picking up work, proving it was " +
      "done, and getting paid.",
    sections: [
      SIGNING_IN,
      {
        heading: "Your company, not just you",
        steps: [
          {
            title: "Several people, several logins",
            body:
              "Your company can have as many logins as it needs — a director, an " +
              "office manager, a supervisor. Everyone sees the company's work; what " +
              "each person may DO is set by your own administrator under \"My Company\".",
          },
          {
            title: "Adding a colleague",
            body:
              "If you hold the \"manage users\" permission, invite them from \"My " +
              "Company\". Never share one login between people — every action is " +
              "recorded against whoever performed it, and a shared password makes that " +
              "meaningless.",
          },
        ],
      },
      {
        heading: "Doing the work",
        steps: [
          {
            title: "Jobs sent to you",
            body:
              "\"My Jobs\" shows what has been dispatched to your company, what it " +
              "involves and when it is due. Accept it so the office knows it has been " +
              "picked up.",
          },
          {
            title: "Photograph the work",
            body:
              "Take before and after photos and attach them to the job. This is not " +
              "paperwork for its own sake — it is what the office checks your invoice " +
              "against, so a job with good photos is paid with fewer questions.",
          },
          {
            title: "Mark it complete",
            body:
              "When the work is done, mark it complete and add a short note of what " +
              "you actually did. Someone from the managing organisation then signs it " +
              "off.",
          },
        ],
      },
      {
        heading: "Getting paid",
        steps: [
          {
            title: "Submit your invoice",
            body:
              "Once a job is signed off, submit your invoice against it from the job " +
              "itself. Submitting it against the job — rather than emailing it — is " +
              "what ties it to the evidence and keeps it moving.",
          },
          {
            title: "Follow it through the approvals",
            body:
              "Payments pass through more than one pair of hands on purpose. You can " +
              "see which stage yours has reached, so you do not have to ring to ask.",
          },
          {
            title: "Your bank details",
            body:
              "You state your bank details once, with the bank's own document as " +
              "evidence. The finance team registers the account separately. Nobody " +
              "will ever ask you for your details over WhatsApp or email — if someone " +
              "does, it is not us.",
          },
        ],
      },
      {
        heading: "Your scorecard",
        steps: [
          {
            title: "How you are measured",
            body:
              "Quality of work 30%, response time 20%, completion time 20%, customer " +
              "satisfaction 20%, compliance 10%. Your score is built from what you " +
              "actually did, and you can see it — it is not a private opinion held " +
              "about you.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "See other contractors' jobs, scores or payments.",
      "See what any other organisation is doing, even one you also work for.",
      "Approve or release your own payment — that is deliberately somebody else's job.",
    ],
  },

  fm_ops_staff: {
    title: "Your day-to-day guide",
    audience: "For operations staff — the jobs assigned to you, and closing them properly.",
    sections: [
      SIGNING_IN,
      {
        heading: "Your work",
        steps: [
          {
            title: "What is assigned to you",
            body:
              "\"My Work\" is your list. It shows what has been dispatched to you, how " +
              "urgent it is and when it is due. It updates itself — you do not need to " +
              "refresh or ask.",
          },
          {
            title: "Do the job, then record it",
            body:
              "Attach photos of the finished work and write a short note of what you " +
              "did. The note matters: it is what the next person reads when the same " +
              "fault comes back in three months.",
          },
          {
            title: "If you cannot complete it",
            body:
              "Say so on the job rather than leaving it open. A job that is blocked and " +
              "says why can be helped; a job that is silently untouched cannot.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "See jobs dispatched to other people or other contractors.",
      "See any financial information — budgets, invoices or payments.",
      "Dispatch work to someone else, or sign off your own job.",
    ],
  },

  property_owner: {
    title: "Your landlord portal",
    audience:
      "For property owners — how your buildings are performing and what is owed to you.",
    sections: [
      SIGNING_IN,
      {
        heading: "Your portfolio",
        steps: [
          {
            title: "What you see",
            body:
              "\"My Portfolio\" covers the properties you own: what is let, what is " +
              "vacant, what has been collected and what is outstanding. It is live — " +
              "not a monthly snapshot prepared for you.",
          },
          {
            title: "Your statements",
            body:
              "Every statement shows rent collected, the management fee deducted at the " +
              "rate agreed with you, and the amount remitted to you. The fee is recorded " +
              "at the moment of collection, so a later change to rates can never " +
              "rewrite a statement you have already had.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "See individual complaints your tenants have raised — those go to the managing team, and you see the property's overall performance instead.",
      "See any property you do not own.",
      "Change rent, fees or tenancy terms directly — ask your managing agent.",
    ],
  },

  viewer: {
    title: "Your read-only access",
    audience: "For external observers — auditors, advisors and oversight parties.",
    sections: [
      SIGNING_IN,
      {
        heading: "What you have",
        steps: [
          {
            title: "One page, honestly scoped",
            body:
              "You are given a single overview rather than degraded copies of the " +
              "operational screens. That is deliberate: a half-working screen showing " +
              "₦0 reads as a broken system rather than as access you do not have.",
          },
          {
            title: "You cannot change anything",
            body:
              "Every screen you can reach is read-only, enforced by the database " +
              "rather than by hiding buttons.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Create, edit, approve or delete anything at all.",
      "See personal details of residents or staff.",
    ],
  },

  finance_approver: {
    title: "Your finance guide",
    audience: "For the finance team — collections, approvals and paying people.",
    sections: [
      SIGNING_IN,
      {
        heading: "Money coming in",
        steps: [
          {
            title: "Collections",
            body:
              "Raise a request for payment against a tenant, a unit or a landlord. " +
              "The payer gets a link, pays by card or transfer, and the ledger updates " +
              "itself when the money actually arrives — not when someone says it has.",
          },
          {
            title: "Reconcile daily",
            body:
              "Compare the bank against the ledger every day rather than at month end. " +
              "A difference found today is a question; the same difference found in " +
              "four weeks is an investigation.",
          },
          {
            title: "Client funds are separate",
            body:
              "Client money sits in its own designated account with its own ledger, " +
              "and is never mixed with the organisation's own funds. Foreign currency " +
              "balances are held and reported separately again — never summed with naira.",
          },
        ],
      },
      {
        heading: "Money going out",
        steps: [
          {
            title: "Nothing is paid without evidence",
            body:
              "A contractor invoice must be attached to a job that was verified and " +
              "signed off. That check happens before the payment chain starts, not " +
              "after it.",
          },
          {
            title: "The approval chain",
            body:
              "Payments climb stages depending on the amount. Approvals are recorded " +
              "with who approved and when. You cannot skip a stage — the chain is " +
              "enforced in the database, not by convention.",
          },
          {
            title: "You release the money",
            body:
              "Only finance executes a remittance. An administrator can approve within " +
              "the threshold and an executive above it, but neither can release funds. " +
              "This is the control that keeps authorising and paying in different hands.",
          },
          {
            title: "You cannot release what you approved",
            body:
              "If you approved a payment yourself, the system will refuse to let you " +
              "also release it, and it will say so. That is the rule working, not a " +
              "fault — it needs a second pair of hands, and the answer is a colleague, " +
              "never a workaround.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Change the approval threshold you approve against.",
      "Release a payment you personally approved.",
      "See the operational request queue — a request reaches you only once money attached to it reaches your desk.",
    ],
  },

  payment_approver: {
    title: "Your approver guide",
    audience: "For payment approvers — checking and authorising what is about to be paid.",
    sections: [
      SIGNING_IN,
      {
        heading: "What reaches you",
        steps: [
          {
            title: "Only what is at your stage",
            body:
              "\"Approvals\" shows payments that have climbed to your stage and are " +
              "within your limit. Your limit is set when you are appointed and can be " +
              "changed by an administrator — not by you.",
          },
          {
            title: "What to check before approving",
            body:
              "That the work was actually verified, that the invoice matches the job, " +
              "and that the amount is what was agreed. Approving is a judgement, not a " +
              "formality — your name stays on it permanently.",
          },
          {
            title: "Rejecting",
            body:
              "Reject with a reason. The reason is what lets a contractor fix and " +
              "resubmit rather than ring to ask what was wrong.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Release money — approving and paying are separate on purpose.",
      "Approve above your own limit.",
      "Change your own limit.",
    ],
  },

  payment_audit_approver: {
    title: "Your audit guide",
    audience: "For the payment auditor — counter-signing what the evidence supports.",
    sections: [
      SIGNING_IN,
      {
        heading: "Your check",
        steps: [
          {
            title: "Invoice against evidence",
            body:
              "Your stage exists to compare the invoice with the job card and the " +
              "photographs. You can see the whole organisation's requests for exactly " +
              "this reason — an auditor who saw only what was routed to them would be " +
              "counter-signing, not auditing.",
          },
          {
            title: "Say what you found",
            body:
              "Record what you actually checked. The audit trail cannot be edited or " +
              "deleted afterwards, by anyone, including administrators.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Approve payments at other stages, or release money.",
      "Alter or remove anything already on the audit trail.",
    ],
  },

  regional_manager: {
    title: "Your regional guide",
    audience: "For regional managers — running the properties in your region.",
    sections: [
      SIGNING_IN,
      {
        heading: "Your region",
        steps: [
          {
            title: "What you cover",
            body:
              "You see every property beneath the region, project or site assigned to " +
              "you. A property added to your region later appears automatically — " +
              "nobody has to re-assign it to you.",
          },
          {
            title: "Inviting operational staff",
            body:
              "You can invite operational people for your own region. You cannot " +
              "invite administrators — that is deliberately not delegable.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "See financial information — budgets, ledgers and payments are not yours.",
      "See properties outside your region.",
      "Invite an administrator.",
    ],
  },

  executive: {
    title: "Your executive guide",
    audience:
      "For the Managing Director and Managing Partner — oversight of the whole organisation.",
    sections: [
      SIGNING_IN,
      {
        heading: "Oversight",
        steps: [
          {
            title: "You see everything",
            body:
              "Every request, every property, the full financial picture and the " +
              "complete audit trail. The dashboard is live rather than a report " +
              "prepared for you.",
          },
          {
            title: "Approving large payments",
            body:
              "Payments above the threshold need your authorisation as well as an " +
              "administrator's.",
          },
          {
            title: "Why you cannot pay",
            body:
              "You authorise; finance disburses. You also cannot raise the threshold " +
              "you approve against — approving against a limit you can lift yourself " +
              "is not an approval, and that separation is what an auditor checks.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Execute a remittance, add or change a bank account, or post to the ledger.",
      "Change the approval threshold you approve against.",
    ],
  },

  admin: {
    title: "Your administrator guide",
    audience:
      "For organisation administrators — setting the place up and keeping it running.",
    sections: [
      SIGNING_IN,
      {
        heading: "Setting up your organisation",
        intro: "Roughly the order to do it in, the first time.",
        steps: [
          {
            title: "1. Your branding",
            body:
              "Settings → Branding. Your logo, colours and support contacts. These " +
              "appear on your sign-in page, your dashboards and every PDF you send out, " +
              "so it is worth doing before anyone else is invited.",
          },
          {
            title: "2. Your places",
            body:
              "Properties. The structure runs region → location → project → site → " +
              "property → unit → asset, but you do not have to build it upfront: file a " +
              "property and create the location or project inline as you go. A property " +
              "that is not filed under anything still works perfectly.",
          },
          {
            title: "3. Your units",
            body:
              "Each property needs its units before it can be invoiced — a budget with " +
              "nothing to divide across cannot produce a bill. Record the occupied space " +
              "in square metres for each; that is what decides each unit's share. One " +
              "row can stand for several units (twelve stalls, four parking bays) — the " +
              "space is per unit and is multiplied by how many.",
          },
          {
            title: "4. Your people",
            body:
              "People → invite. Invite by email and choose their role. Give the " +
              "narrowest role that lets someone do their job; it is easy to widen later " +
              "and awkward to explain afterwards why it was wide.",
          },
          {
            title: "5. Attach people to places",
            body:
              "Open a property and use \"Who is attached to this property\". This is not " +
              "a label — it is the actual access. A manager who is not attached to a " +
              "property cannot see it. You can do this at any time, so forgetting during " +
              "onboarding is easily fixed.",
          },
          {
            title: "6. Your contractors",
            body:
              "Vendors. Register them, choose standard or enhanced checks depending on " +
              "how much scrutiny the work needs, and attach them to the properties they " +
              "work on.",
          },
        ],
      },
      {
        heading: "Running it",
        steps: [
          {
            title: "Approvals and limits",
            body:
              "Settings → Payments. You set who approves and up to what amount. You can " +
              "approve within the threshold yourself — but you cannot then release that " +
              "payment, and that is intentional.",
          },
          {
            title: "When someone leaves",
            body:
              "Deactivate them from People. This immediately removes all access — their " +
              "record and everything they did stays, because the audit trail is never " +
              "rewritten. Do not share their login with a replacement; invite the new " +
              "person properly.",
          },
          {
            title: "What you cannot change",
            body:
              "Some things are fixed by design and never appear as switches: who may " +
              "release money, who may see the audit trail, and the permission matrix " +
              "itself. You can see the matrix; only the platform operator can edit it. " +
              "These are the controls an auditor checks, so they are not preferences.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Edit the permission matrix — you can read it; only the platform operator changes it.",
      "Release a payment, add or change a bank account, or post to the ledger.",
      "Release a payment you approved yourself.",
      "Alter or delete anything on the audit trail.",
    ],
  },
};

/**
 * The FM/PM body, shared by two roles that do the same job in different
 * disciplines (decision 18). Built as a function because the title has to say
 * which of the two the reader is — OEA calls one of them "Properties Manager",
 * and a guide that calls itself the wrong thing is a guide nobody trusts.
 */
export function managerGuide(roleLabel: string): RoleGuide {
  return {
    title: `Your ${roleLabel.toLowerCase()} guide`,
    audience: `For the ${roleLabel} — running the buildings you are responsible for.`,
    sections: [
      SIGNING_IN,
      {
        heading: "Your buildings",
        steps: [
          {
            title: "What you can see",
            body:
              "The properties attached to you, and everything beneath any region or " +
              "site attached to you. If a building you manage is missing, you have not " +
              "been attached to it — ask an administrator, it takes them a moment.",
          },
          {
            title: "Adding a property",
            body:
              "Properties → add. You can create the location, project or site inline " +
              "while filing it, so a building in a city nobody has used before is not a " +
              "dead end.",
          },
          {
            title: "Units and what they pay",
            body:
              "A property needs its units before it can be invoiced. Record each " +
              "unit's occupied space in square metres — that is what decides its share " +
              "of a service-charge budget. One row can stand for several units; the " +
              "space is per unit and multiplied by how many.",
          },
        ],
      },
      {
        heading: "Requests and jobs",
        steps: [
          {
            title: "Your queue",
            body:
              "You land on what is assigned to you. Your buildings' fresh requests are " +
              "one click away — you need to see those to triage them.",
          },
          {
            title: "Review before dispatching",
            body:
              "A request must be reviewed by you before it can be sent to a contractor " +
              "or member of staff. If you raise a job yourself, raising it IS the " +
              "review — there is no second step.",
          },
          {
            title: "Signing off",
            body:
              "When work is reported complete, check the photographs and sign it off. " +
              "A contractor cannot invoice until you have. Signing off work is not the " +
              "same as approving the payment, and you do not do the latter.",
          },
        ],
      },
      {
        heading: "Contractors",
        steps: [
          {
            title: "Who works your buildings",
            body:
              "Attach contractors to a property so their work and performance are " +
              "visible to you. Their scorecard is built from evidence — response time, " +
              "completion time, quality, satisfaction and compliance.",
          },
        ],
      },
      GETTING_HELP,
    ],
    cannot: [
      "Approve or release payments — you sign off the WORK, which is a different thing.",
      "See properties you are not attached to.",
      "Invite administrators.",
    ],
  };
}

/** The guide for a role, or null if that role has none written yet. */
export function guideForRole(role: string, roleLabel: string): RoleGuide | null {
  if (role === "facility_manager" || role === "property_manager") {
    return managerGuide(roleLabel);
  }
  return ROLE_GUIDES[role] ?? null;
}
