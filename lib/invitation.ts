import crypto from "node:crypto";

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
