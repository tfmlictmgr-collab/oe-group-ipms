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

/**
 * Both halves, or neither. Added 20 Sept 2026, after the half-configured state
 * took the vendor application channel offline on staging.
 *
 * ⚠️ The two variables reach a deployment differently and that is the whole
 * trap. `TURNSTILE_SECRET_KEY` is read at request time, so it takes effect the
 * moment it is saved. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is INLINED AT BUILD
 * TIME, so it does nothing until the next deploy — and setting the pair
 * without redeploying leaves exactly this state: a server that demands a token
 * and a page that cannot render the widget to mint one.
 *
 * Every applicant is then refused with "Bot check failed", and reloading does
 * not help, because the widget was never there to reload. The three remaining
 * defences (per-IP rate limit, honeypot, submission timing) are all still
 * running.
 *
 * So a half-configured deployment counts as UNCONFIGURED. That is the same
 * judgement this file's header already makes for a missing key: the downside
 * of a bot getting through is a spam row in a queue a person still approves,
 * and the downside of failing closed is an anonymous channel that is silently
 * shut. Loud, because the fix is a redeploy and nobody will guess that from
 * the symptom.
 */
function siteKeyMissing(): boolean {
  return !process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
}

export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    return { ok: true, skipped: true, reason: "TURNSTILE_SECRET_KEY not set" };
  }

  // See `siteKeyMissing`. The widget cannot exist on this build, so no token
  // can exist either, and refusing everyone would shut the channel rather than
  // protect it.
  if (siteKeyMissing()) {
    console.error(
      "TURNSTILE MISCONFIGURED: TURNSTILE_SECRET_KEY is set but " +
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY is not present in this build, so the " +
      "widget cannot render and no submission can ever carry a token. " +
      "Treating Turnstile as OFF so the form keeps working. " +
      "Fix: set NEXT_PUBLIC_TURNSTILE_SITE_KEY for this environment and REDEPLOY — " +
      "it is inlined at build time, so saving it alone changes nothing."
    );
    return { ok: true, skipped: true, reason: "site key absent from this build" };
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
