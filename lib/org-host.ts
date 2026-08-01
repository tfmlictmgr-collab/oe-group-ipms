import { headers } from "next/headers";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Resolving the request's hostname to the organisation that answers on it.
//
// ⚠️ Branding and routing ONLY. The Host header comes from the client; a proxy
// validates it in production, but nothing here may depend on that. So this
// decides which sign-in screen is painted and never what data anyone reaches —
// the caller's organisation comes from the verified JWT and RLS decides every
// row. A forged Host shows someone another brand's colours on a login form and
// gains them nothing.

export type HostOrg = {
  id: string;
  slug: string | null;
  name: string;
  portal_name: string | null;
  tagline: string | null;
  login_headline: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  theme_accent: string | null;
  theme_logo_text: string | null;
  delivery_brand: string;
};

/** Cache tag for every host lookup, busted whenever a domain is bound or freed. */
export const ORG_DOMAIN_TAG = "org-domains";

// The lookup is one indexed query, but it sits on the entry path of every visit
// — so it is cached by host and invalidated on write rather than being paid for
// on each request. `set_org_domain` is the only thing that changes the mapping,
// and it revalidates this tag.
const lookup = unstable_cache(
  async (host: string): Promise<HostOrg | null> => {
    const { data } = await supabaseAdmin.rpc("org_branding_by_host", { p_host: host });
    return ((data as HostOrg[] | null) ?? [])[0] ?? null;
  },
  ["org-branding-by-host"],
  { tags: [ORG_DOMAIN_TAG], revalidate: 3600 }
);

/** The org answering on this request's hostname, or null for an unbound host. */
export async function orgForCurrentHost(): Promise<HostOrg | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;

  // Localhost and the preview deployments are never brand hosts. Skipping them
  // keeps development on the generic door and saves a pointless round trip.
  const bare = host.split(":")[0].toLowerCase();
  if (bare === "localhost" || bare.endsWith(".vercel.app") || bare === "127.0.0.1") {
    return null;
  }

  return lookup(bare);
}
