"use server";

import { hostServesOrg } from "@/lib/org-host";
import { portalOrigin } from "@/lib/portal-origin";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";
import { generateInviteToken, hashInviteToken } from "@/lib/invitation";
import { sendEmail } from "@/lib/email";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { FM_PM } from "@/lib/roles";

// The public vendor application endpoint — the only unauthenticated write in the
// system. Layers, in order of cost, so an abusive request is dropped as early as
// possible:
//   1. per-IP rate limit          (cheap, sheds floods)
//   2. honeypot + submission timing (free, catches naive bots)
//   3. Turnstile                  (network call, only for plausible submissions)
//   4. per-email rate limit       (stops one address spamming many orgs)
//   5. field validation
//   6. INSERT under RLS, which additionally requires the org to have opened
//      applications and forces status = 'submitted'
//
// Nothing here can create a vendor. Approval is a separate, human, audited step.

export type ApplyInput = {
  orgId: string;
  businessName: string;
  serviceCategory: string;
  cacNumber: string;
  tin: string;
  address: string;
  website: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  // Anti-bot, not business data.
  turnstileToken?: string | null;
  honeypot?: string;      // must stay empty; hidden from real users
  renderedAt?: number;    // epoch ms when the form was rendered
};

export type ApplyResult = ActionResult<void>;

const MIN_FILL_SECONDS = 3;   // a human cannot complete this form faster
const MAX_FORM_AGE_MS = 60 * 60 * 1000; // 1h — stale forms are re-rendered

export async function submitVendorApplication(input: ApplyInput): Promise<ApplyResult> {
  // B1: the page refuses another org's host; so does the submission behind it.
  if (!(await hostServesOrg(input.orgId))) {
    return fail("This link isn't accepting vendor applications at the moment.");
  }

  const h = await headers();
  const ip = clientIp(h);

  // 1 — per-IP rate limit.
  const ipGate = await checkRateLimit("vendor-apply-ip", ip, 5, "10 m");
  if (!ipGate.allowed) {
    return fail("Too many applications from this connection. Please try again later.");
  }

  // 2 — Turnstile (no-ops when unconfigured; see lib/turnstile.ts).
  //
  // ⚠️ Moved AHEAD of the honeypot and timing checks on 20 Sept 2026, because
  // its answer now decides how much those two are allowed to do.
  const ts = await verifyTurnstile(input.turnstileToken, ip);
  if (!ts.ok) {
    return fail("Bot check failed. Please reload the page and try again.");
  }

  // Did Cloudflare actually judge this request, or is Turnstile simply not
  // configured here? `skipped` is the difference, and it is the whole basis of
  // the rule below.
  const vouched = !ts.skipped;

  // 3 — honeypot and timing. Both are silent-ish: a bot gets a generic
  // refusal, never a hint about which control it tripped.
  //
  // ⚠️ **They no longer VETO a request Turnstile has vouched for.** A real
  // application was refused on 20 Sept 2026 because Chrome's autofill filled
  // the off-screen honeypot — see the note on the field in `ApplyForm.tsx`.
  // The field has been renamed so that should not recur, but the deeper fault
  // was the arrangement: a weak browser-behaviour heuristic was overruling a
  // real person, unrecoverably (the field is off-screen, so there is nothing
  // to clear) and undiagnosably (the message cannot say which control tripped,
  // by design).
  //
  // So when Cloudflare has judged the request a human, these two become a
  // LOGGED SIGNAL rather than a refusal. When Turnstile is not configured they
  // reject exactly as before — they are the only control left, and defence in
  // depth is the point.
  //
  // The trade, stated plainly: a bot that defeats Turnstile AND fills the
  // honeypot now gets through where it was previously stopped. What that costs
  // is one spam row in a review queue that a person still has to approve —
  // `lib/turnstile.ts` already weighs the same trade the same way. What the old
  // arrangement cost was a real contractor unable to apply at all, silently.
  const tripped = (control: string, detail?: Record<string, unknown>) => {
    if (vouched) {
      console.warn(
        `vendor application: ${control} tripped but Turnstile vouched for the request — allowing`,
        { ip, ...detail }
      );
      return null;
    }
    console.warn(`vendor application rejected: ${control}`, { ip, ...detail });
    return fail("We couldn't accept this submission. Please try again.");
  };

  if (input.honeypot && input.honeypot.trim() !== "") {
    const refusal = tripped("honeypot filled");
    if (refusal) return refusal;
  }
  if (input.renderedAt) {
    const elapsed = Date.now() - input.renderedAt;
    if (elapsed < MIN_FILL_SECONDS * 1000) {
      const refusal = tripped("submitted too fast", { elapsed });
      if (refusal) return refusal;
    }
    // Not a bot heuristic — a stale form is a correctness problem whoever sent
    // it, so this still refuses unconditionally.
    if (elapsed > MAX_FORM_AGE_MS) {
      return fail("This form has expired. Please reload the page and try again.");
    }
  }

  // 4/5 — validation.
  const email = input.contactEmail.trim().toLowerCase();
  const businessName = input.businessName.trim();
  const contactName = input.contactName.trim();

  if (businessName.length < 2) return fail("Enter your registered business name.");
  if (contactName.length < 2) return fail("Enter a contact name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return fail("Enter a valid email address.");
  }
  // Bound every free-text field so a single request cannot store megabytes.
  const cap = (v: string, n: number) => v.trim().slice(0, n);

  const emailGate = await checkRateLimit("vendor-apply-email", email, 3, "24 h");
  if (!emailGate.allowed) {
    return fail("An application from this email is already being processed.");
  }

  const supabase = await createClient();
  const verificationToken = generateInviteToken();

  const { error } = await supabase.from("vendor_applications").insert({
    org_id: input.orgId,
    business_name: cap(businessName, 160),
    service_category: cap(input.serviceCategory, 80) || null,
    cac_number: cap(input.cacNumber, 40) || null,
    tin: cap(input.tin, 40) || null,
    address: cap(input.address, 300) || null,
    website: cap(input.website, 200) || null,
    contact_name: cap(contactName, 120),
    contact_email: email,
    contact_phone: cap(input.contactPhone, 40) || null,
    notes: cap(input.notes, 1000) || null,
    status: "submitted",
    verification_token_hash: hashInviteToken(verificationToken),
  });

  if (error) {
    // Duplicate is a normal outcome, not a fault — say so plainly.
    if (error.message.includes("vendor_applications_open_uidx")) {
      return fail("You already have an application with us awaiting a decision.");
    }
    // An RLS refusal here means the org isn't accepting applications. Don't
    // reveal whether the org exists.
    if (error.message.includes("row-level security")) {
      return fail("This organisation isn't accepting vendor applications right now.");
    }
    console.error("vendor application insert failed:", error.message);
    return fail("We couldn't submit your application. Please try again.");
  }

  // Tell the people who must act on it. Uses the service role because the
  // applicant is anonymous and has no rights to notify anyone.
  try {
    const { supabaseAdmin } = await import("@/lib/supabase/admin");
    await supabaseAdmin.rpc("notify_role", {
      p_org_id: input.orgId,
      p_roles: ["admin", ...FM_PM],
      p_kind: "application",
      p_title: "New vendor application",
      p_body: `${businessName} has applied to work with you.`,
      p_link: "/dashboard/people/applications",
      p_entity_type: "vendor_application",
    });
  } catch (e) {
    // A notification failure must never fail the applicant's submission.
    console.error("could not raise application notification:", e);
  }

  await trySendVerificationEmail(email, verificationToken, businessName, input.orgId);
  return ok();
}

/**
 * Sends the confirm-your-email link. Quiet when Resend isn't configured — the
 * application is already queued and flagged "Email unverified" in the review
 * queue, so a missing key degrades verification rather than blocking intake.
 */
async function trySendVerificationEmail(
  to: string,
  token: string,
  business: string,
  orgId: string
) {
  const origin = await portalOrigin(orgId);

  await sendEmail({
    to,
    orgId,
    category: "account",
    subject: ({ brandName }) => `Confirm your vendor application to ${brandName}`,
    text: ({ brandName }) =>
      [
        `We've received a vendor application from ${business} to ${brandName}.`,
        ``,
        `Confirm this email address to move your application forward:`,
        `${origin}/apply/confirm/${token}`,
        ``,
        `Confirming only verifies your address — every application is reviewed by`,
        `a person before any decision is made.`,
        ``,
        `If you didn't apply you can safely ignore this email; nothing will happen.`,
        `Any questions, just reply.`,
      ].join("\n"),
  });
}
