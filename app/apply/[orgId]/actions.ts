"use server";

import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";
import { generateInviteToken, hashInviteToken } from "@/lib/invitation";
import { sendEmail } from "@/lib/email";

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

export type ApplyResult = { ok: true } | { ok: false; error: string };

const MIN_FILL_SECONDS = 3;   // a human cannot complete this form faster
const MAX_FORM_AGE_MS = 60 * 60 * 1000; // 1h — stale forms are re-rendered

export async function submitVendorApplication(input: ApplyInput): Promise<ApplyResult> {
  const h = await headers();
  const ip = clientIp(h);

  // 1 — per-IP rate limit.
  const ipGate = await checkRateLimit("vendor-apply-ip", ip, 5, "10 m");
  if (!ipGate.allowed) {
    return { ok: false, error: "Too many applications from this connection. Please try again later." };
  }

  // 2 — honeypot and timing. Both are silent-ish: a bot gets a generic refusal,
  // never a hint about which control it tripped.
  if (input.honeypot && input.honeypot.trim() !== "") {
    console.warn("vendor application rejected: honeypot filled", { ip });
    return { ok: false, error: "We couldn't accept this submission. Please try again." };
  }
  if (input.renderedAt) {
    const elapsed = Date.now() - input.renderedAt;
    if (elapsed < MIN_FILL_SECONDS * 1000) {
      console.warn("vendor application rejected: submitted too fast", { ip, elapsed });
      return { ok: false, error: "We couldn't accept this submission. Please try again." };
    }
    if (elapsed > MAX_FORM_AGE_MS) {
      return { ok: false, error: "This form has expired. Please reload the page and try again." };
    }
  }

  // 3 — Turnstile (no-ops when unconfigured; see lib/turnstile.ts).
  const ts = await verifyTurnstile(input.turnstileToken, ip);
  if (!ts.ok) {
    return { ok: false, error: "Bot check failed. Please reload the page and try again." };
  }

  // 4/5 — validation.
  const email = input.contactEmail.trim().toLowerCase();
  const businessName = input.businessName.trim();
  const contactName = input.contactName.trim();

  if (businessName.length < 2) return { ok: false, error: "Enter your registered business name." };
  if (contactName.length < 2) return { ok: false, error: "Enter a contact name." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  // Bound every free-text field so a single request cannot store megabytes.
  const cap = (v: string, n: number) => v.trim().slice(0, n);

  const emailGate = await checkRateLimit("vendor-apply-email", email, 3, "24 h");
  if (!emailGate.allowed) {
    return { ok: false, error: "An application from this email is already being processed." };
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
      return { ok: false, error: "You already have an application with us awaiting a decision." };
    }
    // An RLS refusal here means the org isn't accepting applications. Don't
    // reveal whether the org exists.
    if (error.message.includes("row-level security")) {
      return { ok: false, error: "This organisation isn't accepting vendor applications right now." };
    }
    console.error("vendor application insert failed:", error.message);
    return { ok: false, error: "We couldn't submit your application. Please try again." };
  }

  await trySendVerificationEmail(email, verificationToken, businessName, input.orgId);
  return { ok: true };
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
  const h = await headers();
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

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
