// Curated answers the help assistant finds first.
//
// The guides and the process catalogue say how a journey RUNS; people ask the
// short question ("how do I invite a landlord?") and need the exact clicks. An
// entry here is written once, checked against the screen it describes, and
// shown only to the roles listed. When Settings → Help Questions shows a
// question the assistant missed, the fix is usually an entry here (or one more
// everyday word in `CONCEPTS` in lib/help-bot.ts) - never the model "learning".
//
// Every screen and button name below was read from the code that renders it:
// People → Invitations, the "Invite someone" card, "Issue invitation",
// Vendors → Add Vendor, Properties owned, Vendor record. Update this file in
// the same change as the screen.

export type Faq = {
  /** Phrased the way a person asks, using the everyday words (invite, onboard, add). */
  question: string;
  /** Roles that may be told this. */
  roles: string[];
  answer: string;
};

const INVITERS = ["admin", "regional_manager", "property_manager", "facility_manager"];

export const FAQ: Faq[] = [
  {
    question: "How do I invite or onboard a tenant?",
    roles: INVITERS,
    answer:
      "It depends on whether the tenant is NEW or already in a tenancy. " +
      "A NEW tenant (where your organisation takes tenancy applications): do not invite them directly. " +
      "1. They apply through the property's application link. " +
      "2. People → Tenancy Applications: review the application and record your reason. " +
      "3. Approve it and issue the letter of offer with the rent, term and deposit. " +
      "4. When they accept the offer, their invitation is sent to them automatically. " +
      "A tenant who is ALREADY in a tenancy (for example from an existing rent roll): " +
      "1. People → Invitations, the \"Invite someone\" card. " +
      "2. Enter their email address and name. " +
      "3. Role: Tenant. " +
      "4. Unit: pick the unit they live in, or leave \"assign later\". " +
      "5. Click \"Issue invitation\". " +
      "The invitation is emailed and the link is shown so you can copy it. It is valid for 14 days. " +
      "They open it, set their own password, and set up two-factor sign-in when your organisation asks for it.",
  },
  {
    question: "How do I invite or onboard a landlord (property owner)?",
    roles: INVITERS,
    answer:
      "The building must already be on the system (Properties). Then: " +
      "1. People → Invitations, the \"Invite someone\" card. " +
      "2. Enter their email address and name. " +
      "3. Role: Property Owner. " +
      "4. Under \"Properties owned\", tick each building they own. " +
      "5. Click \"Issue invitation\". " +
      "The invitation is emailed and the link is shown so you can copy it. It is valid for 14 days. " +
      "Once they accept, they see only the statements, payments and reports of the buildings you ticked, and nobody else's. " +
      "To give them another building later, ask your administrator.",
  },
  {
    question: "How do I invite or onboard a vendor (contractor)?",
    roles: INVITERS,
    answer:
      "The company comes first, then the person's login. " +
      "1. Vendors → Add Vendor: enter the company's details. " +
      "(Or the contractor registers themselves through the vendor registration link, and you approve them under Registrations.) " +
      "2. People → Invitations, the \"Invite someone\" card. " +
      "3. Role: Vendor. " +
      "4. \"Vendor record\": pick the company; the email and contact name fill in. " +
      "5. Click \"Issue invitation\". " +
      "The invitation is emailed and the link is shown so you can copy it. It is valid for 14 days. " +
      "Each further person at the same company gets their own invitation the same way. " +
      "After that, attach the vendor to the properties they work on and evaluate them after their first job.",
  },
  {
    question: "What happens after I invite someone? How do I cancel or redo an invitation?",
    roles: INVITERS,
    answer:
      "The invitation stays under pending invitations on People → Invitations until it is accepted or expires after 14 days. " +
      "From there you can Revoke it. The person opens the link, sets their own password and signs in with exactly the role you chose; they cannot change it. " +
      "There is no resend button: if it never arrived or has expired, revoke it and issue a new one, or copy the link shown when you issued it and send it to them yourself.",
  },
  {
    question: "Which roles can I invite?",
    roles: INVITERS,
    answer:
      "The role list on the invitation form only offers what you may invite. " +
      "An administrator can invite anyone. " +
      "A regional manager can invite facilities and property managers, landlords, tenants and vendors, within their own region. " +
      "A facilities or property manager can invite operations staff, landlords, tenants, vendors and read-only observers, for the properties they hold. " +
      "Only an administrator appoints another administrator, the Managing Director or Managing Partner, the Payment Officer, the Payment Auditor and the Payment Approver. " +
      "If a role is not in your list, ask your administrator.",
  },
];
