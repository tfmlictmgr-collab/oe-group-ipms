import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { orgForCurrentHost } from "@/lib/org-host";
import SignInPanel from "@/components/auth/sign-in-panel";

// An organisation's own front door.
//
// Resolved through `org_public_branding`, which takes a slug and returns at most
// one row — it cannot be made to list, so holding one org's link never reveals
// that another exists. A wrong slug and a retired org both answer 404, for the
// same reason the public tenancy page does: distinguishing them would let
// someone map which organisations are on the platform.
//
// Never cached: branding is admin-editable and a stale render would show a
// client the colours they just changed away from.
export const dynamic = "force-dynamic";

type Branding = {
  id: string;
  name: string;
  portal_name: string | null;
  tagline: string | null;
  login_headline: string | null;
  logo_url: string | null;
  theme_primary: string | null;
  theme_logo_text: string | null;
};

async function brandingFor(slug: string): Promise<Branding | null> {
  const { data } = await supabaseAdmin.rpc("org_public_branding", { p_slug: slug });
  return (data as Branding[] | null)?.[0] ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const org = await brandingFor(slug);
  if (!org) return { title: "Sign in" };

  const name = org.portal_name || org.name;
  return {
    title: `${name} — Sign in`,
    // Set explicitly, so this page cannot inherit the root description. That is
    // how the other brand's name reached this door: root metadata cascades, and
    // a link preview of THIS page was rendering it.
    description: `Sign in to ${name}.`,
    // A client's own portal has no business in a search index.
    robots: { index: false, follow: false },
    openGraph: {
      title: `${name} — Sign in`,
      description: `Sign in to ${name}.`,
      siteName: name,
    },
  };
}

export default async function OrgLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // A hostname bound to one organisation serves ONLY that organisation's door.
  // Without this, portal.tfmlconsultant.com/o/oea would paint OEA's brand on
  // TFML's domain — a cross-brand surface on a host a client believes is
  // exclusively theirs, which is precisely what B1 exists to prevent. Answered
  // as 404 rather than a redirect, so the host cannot be used to enumerate
  // which slugs exist.
  const hostOrg = await orgForCurrentHost();
  if (hostOrg && hostOrg.slug?.toLowerCase() !== slug.toLowerCase()) notFound();

  const org = await brandingFor(slug);
  if (!org) notFound();

  const primary = /^#[0-9a-fA-F]{6}$/.test(org.theme_primary ?? "")
    ? org.theme_primary!
    : "#003366";
  const portalName = org.portal_name || org.name;

  return (
    <SignInPanel
      brand={{
        portalName,
        logoText: org.theme_logo_text || portalName.slice(0, 2).toUpperCase(),
        logoUrl: org.logo_url,
        primary,
        headline: org.login_headline || `Welcome to ${portalName}.`,
        tagline:
          org.tagline ||
          "Requests, service charges, vendor performance and payments — in one auditable place.",
        // The organisation's own name, so its door carries its copyright and no
        // one else's (B1).
        owner: org.name,
      }}
      // Deliberately no "not your organisation?" link. It used to point at
      // /login, which is now the PLATFORM OPERATOR's door — inviting a client to
      // OE Group's own sign-in, from their own branded page. A client who is on
      // the wrong org's address should ask whoever sent them the link.
    />
  );
}
