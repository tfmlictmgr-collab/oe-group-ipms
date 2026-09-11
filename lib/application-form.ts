// The two application forms, as data.
//
// Mirrors the three OEA paper forms — New Tenants Acquaintance (individual),
// Guarantor/Referee (individual), Tenant KYC Shopping Mall (corporate). Kept as
// a declaration rather than JSX so the same definition drives the form, the
// validation, the reviewer's read-only rendering and the printable template.
// Four renderings of one truth beat four that drift.
//
// `sensitive: true` marks special-category personal data under NDPA. Those
// fields are optional, visually separated, and stored in a different column
// (0062) — a reviewer's normal view never selects them.

export type FieldType = "text" | "email" | "tel" | "date" | "number" | "select" | "textarea" | "checkbox";

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  hint?: string;
  /** Special-category under NDPA: optional, gated, stored apart. */
  sensitive?: boolean;
  /** Half-width on desktop. Long text and addresses take the full row. */
  half?: boolean;
  /**
   * A select whose options depend on another field's value — the LGA list is
   * decided by the state above it.
   *
   * `optionsFrom` names the field to read, `optionsBy` maps that field's value
   * to the options offered. Kept as data on the field rather than a special
   * case in the renderer, so the next dependent pair costs a line and not a
   * branch.
   */
  optionsFrom?: string;
  optionsBy?: Record<string, string[]>;
};

export type Section = {
  key: string;
  title: string;
  description?: string;
  fields: Field[];
};

import { LGA_BY_STATE } from "./nigeria-lgas";

const NIGERIAN_STATES = [
  "Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno",
  "Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT — Abuja","Gombe",
  "Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos",
  "Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto",
  "Taraba","Yobe","Zamfara",
];

export const INDIVIDUAL_SECTIONS: Section[] = [
  {
    key: "personal",
    title: "About you",
    fields: [
      { key: "full_name", label: "Full name", type: "text", required: true },
      { key: "date_of_birth", label: "Date of birth", type: "date", half: true },
      { key: "sex", label: "Sex", type: "select", options: ["Female", "Male", "Prefer not to say"], half: true },
      { key: "state_of_origin", label: "State of origin", type: "select", options: NIGERIAN_STATES, half: true },
      // ⚠️ Was free text, directly beneath a state DROPDOWN — so "Ikeja",
      // "IKEJA" and "Ikeja LGA" all arrived as different values. 0186's finding
      // about locations, one level down: an offered list is what stops the
      // spellings, and the 774 LGAs are a closed set, which is what makes them
      // offerable. The options are decided by the state chosen above.
      {
        key: "lga", label: "Local government area", type: "select", half: true,
        optionsFrom: "state_of_origin", optionsBy: LGA_BY_STATE,
        hint: "Choose your state of origin first.",
      },
      { key: "phone", label: "Phone number", type: "tel", required: true, half: true },
      { key: "alt_phone", label: "Alternative phone", type: "tel", half: true },
      { key: "email", label: "Email address", type: "email", required: true, half: true },
      { key: "current_address", label: "Current residential address", type: "textarea", required: true },
    ],
  },
  {
    key: "employment",
    title: "Work",
    description: "How the rent will be supported. We do not contact an employer without telling you.",
    fields: [
      { key: "employment_status", label: "Employment status", type: "select", required: true,
        options: ["Employed", "Self-employed", "Business owner", "Retired", "Student", "Other"], half: true },
      { key: "employer_name", label: "Employer or business name", type: "text", half: true },
      { key: "position", label: "Position", type: "text", half: true },
      { key: "years_in_role", label: "Years in this role", type: "number", half: true },
      { key: "employer_address", label: "Employer or business address", type: "textarea" },
      { key: "cac_number", label: "CAC number", type: "text",
        hint: "If self-employed or a business owner.", half: true },
    ],
  },
  {
    key: "residence_history",
    title: "Where you live now",
    fields: [
      { key: "years_at_current", label: "Years at your current address", type: "number", half: true },
      { key: "reason_for_moving", label: "Reason for moving", type: "text", half: true },
      { key: "former_address", label: "Previous address", type: "textarea" },
      { key: "former_landlord_name", label: "Previous landlord or agent", type: "text", half: true },
      { key: "former_landlord_phone", label: "Their phone number", type: "tel", half: true },
    ],
  },
  {
    key: "tenancy",
    title: "The tenancy you want",
    fields: [
      { key: "intended_use", label: "Intended use", type: "select", required: true,
        options: ["Residential — family", "Residential — single occupant", "Residential — shared", "Other"], half: true },
      { key: "occupants", label: "Number of occupants", type: "number", required: true, half: true },
      { key: "has_pets", label: "Any pets", type: "checkbox", half: true },
      { key: "pets_detail", label: "If yes, what kind", type: "text", half: true },
      { key: "preferred_move_in", label: "Preferred move-in date", type: "date", half: true },
      { key: "lease_term_months", label: "Lease term wanted (months)", type: "number", half: true },
    ],
  },
  {
    key: "family",
    title: "Next of kin",
    description:
      "Marital status and religion appear on our paper form. They are optional here, are not used in any decision, and are stored separately from the rest of your application.",
    fields: [
      { key: "next_of_kin_name", label: "Next of kin", type: "text", required: true, half: true },
      { key: "next_of_kin_phone", label: "Their phone number", type: "tel", required: true, half: true },
      { key: "next_of_kin_relationship", label: "Relationship to you", type: "text", half: true },
      { key: "marital_status", label: "Marital status", type: "select", sensitive: true,
        options: ["Prefer not to say", "Single", "Married", "Divorced", "Widowed"], half: true },
      { key: "religion", label: "Religion", type: "text", sensitive: true, half: true },
    ],
  },
  {
    key: "guarantor",
    title: "Guarantor and referees",
    description: "One guarantor and two referees, as on the OEA guarantor form.",
    fields: [
      { key: "guarantor_name", label: "Guarantor's full name", type: "text", required: true, half: true },
      { key: "guarantor_phone", label: "Guarantor's phone", type: "tel", required: true, half: true },
      { key: "guarantor_address", label: "Guarantor's address", type: "textarea", required: true },
      { key: "guarantor_occupation", label: "Guarantor's occupation", type: "text", half: true },
      { key: "guarantor_relationship", label: "Relationship to you", type: "text", half: true },
      { key: "referee1_name", label: "First referee", type: "text", required: true, half: true },
      { key: "referee1_phone", label: "Their phone", type: "tel", required: true, half: true },
      { key: "referee2_name", label: "Second referee", type: "text", required: true, half: true },
      { key: "referee2_phone", label: "Their phone", type: "tel", required: true, half: true },
    ],
  },
];

export const CORPORATE_SECTIONS: Section[] = [
  {
    key: "business",
    title: "The business",
    fields: [
      { key: "registered_name", label: "Registered company name", type: "text", required: true },
      { key: "trading_name", label: "Trading name, if different", type: "text" },
      { key: "cac_number", label: "CAC registration number", type: "text", required: true, half: true },
      { key: "tin", label: "Tax identification number (TIN)", type: "text", required: true, half: true },
      { key: "business_structure", label: "Structure", type: "select", required: true,
        options: ["Limited liability company", "Business name / enterprise", "Partnership", "Incorporated trustees", "Other"], half: true },
      { key: "business_category", label: "Category", type: "text", half: true,
        hint: "e.g. Fashion retail, Pharmacy, Quick-service restaurant" },
      { key: "nature_of_business", label: "Nature of business", type: "textarea", required: true },
      { key: "registered_address", label: "Registered address", type: "textarea", required: true },
      { key: "website", label: "Website", type: "text", half: true },
      { key: "social_handle", label: "Main social handle", type: "text", half: true },
    ],
  },
  {
    key: "contact",
    title: "Authorised contact",
    description: "The person who can sign for the business.",
    fields: [
      { key: "contact_name", label: "Full name", type: "text", required: true, half: true },
      { key: "contact_position", label: "Position", type: "text", required: true, half: true },
      { key: "contact_phone", label: "Phone", type: "tel", required: true, half: true },
      { key: "contact_email", label: "Email", type: "email", required: true, half: true },
      { key: "contact_id_type", label: "ID type", type: "select",
        options: ["National ID (NIN)", "International passport", "Driver's licence", "Voter's card"], half: true },
      { key: "contact_id_number", label: "ID number", type: "text", half: true },
    ],
  },
  {
    key: "trading_history",
    title: "Trading history",
    fields: [
      { key: "years_trading", label: "Years trading", type: "number", required: true, half: true },
      { key: "branch_count", label: "Number of branches", type: "number", half: true },
      { key: "is_franchise", label: "Operating as a franchise", type: "checkbox", half: true },
      { key: "franchise_brand", label: "If yes, which brand", type: "text", half: true },
      { key: "current_landlord", label: "Current landlord or property manager", type: "text", half: true },
      { key: "current_landlord_phone", label: "Their phone", type: "tel", half: true },
    ],
  },
  {
    key: "proposed_tenancy",
    title: "The space you want",
    fields: [
      { key: "unit_preference", label: "Unit or shop preference", type: "text", half: true },
      { key: "size_sqm", label: "Size wanted (sqm)", type: "number", half: true },
      { key: "floor_preference", label: "Floor preference", type: "text", half: true },
      { key: "lease_term_months", label: "Lease term wanted (months)", type: "number", required: true, half: true },
      { key: "preferred_move_in", label: "Preferred move-in date", type: "date", half: true },
      { key: "intended_use", label: "Intended use of the space", type: "textarea", required: true },
      { key: "fit_out_required", label: "Fit-out required", type: "checkbox", half: true },
      { key: "signage_required", label: "External signage required", type: "checkbox", half: true },
    ],
  },
  {
    key: "financial",
    title: "Financial and references",
    fields: [
      { key: "bank_name", label: "Bank", type: "text", required: true, half: true },
      { key: "bank_reference_contact", label: "Bank reference contact", type: "text", half: true },
      { key: "guarantor_name", label: "Corporate guarantor", type: "text", half: true },
      { key: "guarantor_phone", label: "Guarantor's phone", type: "tel", half: true },
      { key: "trade_ref1_company", label: "First trade reference — company", type: "text", required: true, half: true },
      { key: "trade_ref1_contact", label: "Contact and phone", type: "text", required: true, half: true },
      { key: "trade_ref2_company", label: "Second trade reference — company", type: "text", required: true, half: true },
      { key: "trade_ref2_contact", label: "Contact and phone", type: "text", required: true, half: true },
    ],
  },
];

export function sectionsFor(type: "individual" | "corporate"): Section[] {
  return type === "corporate" ? CORPORATE_SECTIONS : INDIVIDUAL_SECTIONS;
}

/** Documents each application type must attach before it can be submitted. */
export const REQUIRED_DOCUMENTS: Record<"individual" | "corporate", { kind: string; label: string }[]> = {
  individual: [
    { kind: "national_id", label: "Government-issued ID" },
    { kind: "passport_photo", label: "Passport photograph" },
    { kind: "guarantor_id", label: "Guarantor's ID" },
  ],
  corporate: [
    { kind: "cac", label: "CAC certificate" },
    { kind: "tin", label: "TIN or tax clearance" },
    { kind: "national_id", label: "Authorised contact's ID" },
  ],
};

export const OPTIONAL_DOCUMENTS = [
  { kind: "work_id", label: "Work ID" },
  { kind: "company_profile", label: "Company profile" },
  { kind: "bank_reference", label: "Bank reference letter" },
  { kind: "other", label: "Anything else" },
];

/**
 * A written statement to go with the application.
 *
 * "Anything else" was an upload slot and nothing more, so an applicant with a
 * gap in their employment, an unusual guarantor arrangement or a reason a
 * document looks odd had a way to ATTACH a file and no way to say what it was.
 * A reviewer then read the attachment cold. This is the sentence that goes with
 * it.
 *
 * ⚠️ Deliberately NOT `sensitive: true`, and the hint says why in the
 * applicant's own terms. `sensitive` is decision 10's separate column for
 * special-category data (religion, marital status) which is stored apart and
 * never sent to a model — a free-text box is exactly where somebody volunteers
 * a health condition, so the hint asks them not to, rather than the field
 * quietly reclassifying whatever they type. What an applicant chooses to write
 * cannot be predicted by a flag; it can only be asked for narrowly.
 */
export const APPLICANT_STATEMENT_FIELD: Field = {
  key: "applicant_statement",
  label: "Anything else you would like the reviewer to know",
  type: "textarea",
  hint:
    "Optional. Use this to explain anything about your application or the documents you have attached — " +
    "a gap in employment, an unusual guarantor arrangement, a document in another name. " +
    "Please do not include health, religious or other sensitive personal details; they are not needed to assess a tenancy.",
};

/**
 * What the applicant is consenting to. Stored verbatim on the application, so a
 * later change to this wording cannot retroactively alter what someone agreed
 * to — the record has to say what they actually saw.
 */
export const CONSENT_STATEMENT =
  "I confirm the information given is true, and I consent to it being used to assess this tenancy application only. " +
  "I understand it will be seen by the property team handling this application, will not be used for any automated " +
  "decision, and that I can ask for it to be corrected or deleted. If this application is unsuccessful my personal " +
  "details are deleted after 90 days. " +
  "I understand that the documents I upload may be checked automatically for completeness and for consistency with " +
  "what I have written here, that these checks produce notes for the person reviewing my application and never a " +
  "decision, and that I can ask for any such note to be corrected if it is wrong.";

/** Splits a filled form into the general payload and the special-category part. */
export function splitSensitive(
  type: "individual" | "corporate",
  values: Record<string, unknown>
): { form: Record<string, unknown>; sensitive: Record<string, unknown> } {
  const sensitiveKeys = new Set(
    sectionsFor(type).flatMap((s) => s.fields.filter((f) => f.sensitive).map((f) => f.key))
  );
  const form: Record<string, unknown> = {};
  const sensitive: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === "" || v === null || v === undefined) continue;
    (sensitiveKeys.has(k) ? sensitive : form)[k] = v;
  }
  return { form, sensitive };
}

/** Missing required answers, by field label — for the submit-time check. */
export function missingRequired(
  type: "individual" | "corporate",
  values: Record<string, unknown>
): string[] {
  return sectionsFor(type)
    .flatMap((s) => s.fields)
    .filter((f) => f.required && f.type !== "checkbox")
    .filter((f) => {
      const v = values[f.key];
      return v === undefined || v === null || String(v).trim() === "";
    })
    .map((f) => f.label);
}
