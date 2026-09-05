import { supabaseAdmin } from "@/lib/supabase/admin";

// Resolving the organisation behind a PUBLIC link — a tenancy application, a
// vendor registration — from either its slug or its id.
//
// ⚠️ Why the slug matters here. These links are handed to strangers: a
// prospective tenant, a contractor who wants to register. Until now they carried
// a raw uuid, so what a client sent out was
// `…/tenancy/98638544-8e25-44ab-9a20-7f1aac3a1534` — unreadable, impossible to
// say over the phone, and it looks like a tracking token rather than an address.
// `…/tenancy/oea` is the same link a person can read and retype.
//
// ⚠️ Ids still resolve, permanently. Links already sent out are in emails, on
// printed sheets and in WhatsApp threads; breaking them to tidy a URL would
// silently strand applicants who did nothing wrong.
//
// The service role is used because there is no session — a stranger has no
// account — and only the org's public face is ever selected.

export type PublicOrg = {
  id: string;
  slug: string | null;
  name: string;
  portal_name: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  delivery_brand: string;
  tenant_applications_open: boolean;
  vendor_applications_open: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The org behind a public handle, or null.
 *
 * Null covers a wrong slug, an unknown id and a retired org alike — the caller
 * answers all three with the same 404, so the platform cannot be mapped by
 * probing handles.
 */
export async function resolvePublicOrg(handle: string): Promise<PublicOrg | null> {
  const clean = decodeURIComponent(handle ?? "").trim();
  if (!clean) return null;

  const columns =
    "id, slug, name, portal_name, logo_url, theme_primary, delivery_brand, " +
    "tenant_applications_open, vendor_applications_open";

  // A uuid is matched as a uuid and a slug as a slug — never both in one `or`,
  // which would make a slug shaped like an id ambiguous and, worse, send
  // non-uuid text to a uuid comparison and error rather than simply not match.
  const query = supabaseAdmin.from("orgs").select(columns).is("deleted_at", null);
  const { data } = UUID.test(clean)
    ? await query.eq("id", clean).maybeSingle()
    : await query.ilike("slug", clean).maybeSingle();

  return (data as PublicOrg | null) ?? null;
}

/** The public handle to PUT IN a link: the slug when there is one. */
export function publicHandle(org: { id: string; slug: string | null }): string {
  return org.slug || org.id;
}
