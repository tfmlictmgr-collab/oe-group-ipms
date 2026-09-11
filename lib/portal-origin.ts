import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The address a link to THIS organisation's portal should carry — in an email,
 * a WhatsApp message, a shareable application link, or a payment gateway's
 * return URL.
 *
 * ⚠️ Added 11 Sept 2026, replacing fourteen copies of
 *
 *     process.env.NEXT_PUBLIC_SITE_URL ?? `${proto}://${host}`
 *
 * which answered a different question: "which deployment is running this
 * code", not "whose portal is this link for". NEXT_PUBLIC_SITE_URL is one
 * value per deployment — on staging it is a generic `*.vercel.app` address —
 * so every invitation, receipt link, renewal notice and Paystack return URL an
 * OEA tenant received pointed at a host that is not OEA's. A scheduled job
 * running on one project wrote the same host into every organisation's
 * letters. B1 says a user on one portal must never see the other brand's
 * data OR EXISTENCE, and an address is the most visible thing in a message.
 *
 * The order:
 *   1. the request's own host, when it already answers for this org (someone
 *      acting on oeaportal.com stays on oeaportal.com) or is a development /
 *      preview host that answers for nobody (localhost, *.vercel.app) — so
 *      testing a flow never throws the tester onto the live domain;
 *   2. the organisation's own bound domain (`orgs.custom_domain`, set only by
 *      an operator through `set_org_domain`);
 *   3. the deployment's configured address, then the request host — the old
 *      behaviour, reached only for an org with no domain of its own, where
 *      there is no better answer.
 *
 * A request host bound to a DIFFERENT organisation is never used: that is the
 * TFML-domain-in-an-OEA-letter case this exists to stop.
 *
 * `purpose`:
 *   • "message" (default) — a link that will be READ BY SOMEONE ELSE, later: an
 *     email, a notice, an invitation, a link staff copy and share. Step 1 is
 *     skipped for development hosts, because the recipient is not on the
 *     developer's machine, and a scheduled job reached on `*.vercel.app` must
 *     still write the organisation's own address into every letter.
 *   • "return" — where THIS request's own user is sent back to (a payment
 *     gateway's callback). Staying on the host they are using is right, even a
 *     preview one — a tester must not be thrown onto the live domain mid-flow.
 */
export async function portalOrigin(
  orgId: string | null | undefined,
  purpose: "message" | "return" = "message"
): Promise<string> {
  let requestOrigin: string | null = null;
  let requestHost: string | null = null;
  try {
    const h = await headers();
    requestHost = (h.get("x-forwarded-host") ?? h.get("host"))?.toLowerCase() ?? null;
    if (requestHost) {
      const proto =
        h.get("x-forwarded-proto") ?? (requestHost.startsWith("localhost") ? "http" : "https");
      requestOrigin = `${proto}://${requestHost}`;
    }
  } catch {
    // No request in scope (a cron job reached without one, a script). Fine —
    // the organisation's own domain is the better answer there anyway.
  }

  const bare = requestHost?.split(":")[0] ?? null;
  const devHost =
    !!bare && (bare === "localhost" || bare === "127.0.0.1" || bare.endsWith(".vercel.app"));

  let domain: string | null = null;
  if (orgId) {
    const { data } = await supabaseAdmin
      .from("orgs").select("custom_domain").eq("id", orgId).maybeSingle();
    domain = (data?.custom_domain as string | null)?.trim().toLowerCase() || null;
  }

  const strip = (h: string) => h.replace(/^www\./, "");
  if (requestOrigin && bare) {
    if (devHost && purpose === "return") return requestOrigin;
    if (domain && strip(bare) === strip(domain)) return requestOrigin;
  }
  if (domain) return `https://${domain}`;

  // No domain of its own. The request host is usable only if it answers for
  // NOBODY — a host bound to another organisation must not be lent out, even
  // as a last resort, because that is the whole fault this function exists for.
  let requestIsForeignBrand = false;
  if (bare && !devHost) {
    const { data } = await supabaseAdmin.rpc("org_branding_by_host", { p_host: bare });
    const owner = ((data as { id: string }[] | null) ?? [])[0];
    requestIsForeignBrand = Boolean(owner && owner.id !== orgId);
  }
  const fallback =
    process.env.NEXT_PUBLIC_SITE_URL ?? (requestIsForeignBrand ? null : requestOrigin) ?? "";
  return fallback.replace(/\/$/, "");
}
