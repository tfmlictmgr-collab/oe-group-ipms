import crypto from "node:crypto";
import { sendEmail } from "@/lib/email";
import { roleLabel } from "@/lib/roles";

// Invitation tokens follow the password-reset pattern: a high-entropy random
// value is shown to the inviter exactly once, and only its SHA-256 hash is
// stored. A database read therefore cannot be replayed as a working invitation.

/** 32 bytes of entropy, URL-safe. */
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string): string {
  return crypto.createHash("sha256").update(token.trim()).digest("hex");
}

/** The link the invitee opens. Absolute so it survives being pasted anywhere. */
export function buildInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/invite/${token}`;
}

/**
 * Best-effort email. Returns whether the provider ACCEPTED it — never whether it
 * arrived; that is only known once the delivery webhook reports back. Returns
 * false (not an error) when Resend isn't configured: the caller still has the
 * shareable link, so onboarding is never blocked.
 * Category "account", so replies reach the org's support inbox rather than the
 * unmonitored sending subdomain.
 *
 * The copy names the CLIENT-FACING BRAND, never the holding entity (B1): a TFML
 * recipient reads "TFML portal". The role is rendered with the
 * brand-aware label, so TFML says "Operations Staff" where OEA says "Property
 * Operations Staff" — not the raw database value.
 *
 * Shared by both invite paths — staff issuing any invitation (people/actions.ts)
 * and a vendor owner inviting their own colleague (my-company/actions.ts). One
 * function, so the wording never quietly diverges between them.
 */
export async function sendInviteEmail(
  to: string,
  url: string,
  role: string,
  orgId: string,
  brand: string | null,
  invitedByName: string | null,
  invitationId: string | null
): Promise<boolean> {
  const roleName = roleLabel(role, brand);

  const res = await sendEmail({
    to,
    orgId,
    category: "account",
    entityType: "invitation",
    entityId: invitationId,
    subject: ({ brandName }) => `You've been invited to the ${brandName} portal`,
    text: ({ brandName }) =>
      [
        `You've been invited to join the ${brandName} portal as ${roleName}.`,
        ...(invitedByName ? [``, `Invited by ${invitedByName}.`] : []),
        ``,
        `Set your password to get started:`,
        url,
        ``,
        `This link expires in 14 days and can only be used once.`,
        ``,
        `If you weren't expecting this invitation you can safely ignore this email`,
        `— or reply to it if you'd like to confirm it's genuine.`,
      ].join("\n"),
  });
  return res.sent;
}
