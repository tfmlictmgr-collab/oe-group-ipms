// Cloudflare Turnstile verification for public form submissions.
//
// Policy mirrors webhook-security.ts in spirit but differs deliberately in one
// respect: a missing Turnstile key does NOT reject submissions. Turnstile is a
// bot-resistance layer, not an authorisation gate — the authorisation gate for a
// vendor application is human approval, which can never be bypassed. Failing
// closed here would take the whole application channel offline for a missing
// optional key, while the actual downside of a bot getting through is a spam row
// in a review queue that a person still has to approve.
//
// Rate limiting and the honeypot/timing checks run regardless, so the endpoint
// is never unprotected.

export type TurnstileResult = { ok: boolean; skipped: boolean; reason?: string };

export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: true, skipped: true, reason: "TURNSTILE_SECRET_KEY not set" };
  }
  if (!token) return { ok: false, skipped: false, reason: "missing turnstile token" };

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return data.success
      ? { ok: true, skipped: false }
      : { ok: false, skipped: false, reason: (data["error-codes"] ?? []).join(", ") };
  } catch (e) {
    // A Cloudflare outage must not block legitimate applicants; the human gate
    // still stands behind this.
    console.error("Turnstile verification error (allowing through):", e);
    return { ok: true, skipped: true, reason: "verification unavailable" };
  }
}
