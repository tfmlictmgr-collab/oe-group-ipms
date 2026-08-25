import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { getSessionProfile } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { guideForRole } from "@/lib/guides/content";
import { RoleGuideDocument } from "@/lib/pdf/role-guide";

// The signed-in person's own role guide, as a branded PDF.
//
// ⚠️ It takes NO parameter for which role to render. The role comes from the
// caller's own profile, so there is no `?role=admin` to try — a tenant cannot
// fetch the administrator's handbook, which names controls, thresholds and how
// the approval chain is arranged. That is not secret exactly, but it is not
// theirs, and a guide reachable by guessing a query string is an enumeration
// waiting to be found.
//
// Generated on demand rather than stored, for the same reason receipts are: a
// guide built at request time cannot describe a version of the product that no
// longer exists, and no stale file sits in a bucket contradicting the screen.
export const runtime = "nodejs";

export async function GET(_request: NextRequest) {
  const session = await getSessionProfile();
  if (!session?.profile || !session.org) {
    return new NextResponse("Sign in required", { status: 401 });
  }

  const { profile, org } = session;
  const label = roleLabel(profile.role, org.delivery_brand);
  const guide = guideForRole(profile.role, label);

  // A role with no guide written yet says so plainly rather than serving an
  // empty document that looks like a broken download.
  if (!guide) {
    return new NextResponse(
      "There is no guide for your role yet. Please ask your administrator.",
      { status: 404 }
    );
  }

  const buffer = await renderToBuffer(
    <RoleGuideDocument
      org={{
        name: org.name,
        logoUrl: org.logo_url ?? null,
        primary: org.theme_primary ?? "#003366",
        tagline: org.tagline ?? null,
        supportEmail: org.support_email ?? null,
        supportPhone: org.support_phone ?? null,
        portalName: org.portal_name ?? null,
      }}
      guide={guide}
      roleLabel={label}
      // Naming the reader makes a leaked copy traceable to whoever downloaded
      // it, which is the cheapest deterrent available for a document nobody
      // can encrypt.
      generatedFor={profile.full_name || profile.email || "a member of staff"}
      generatedAt={new Date().toLocaleDateString("en-GB", {
        timeZone: "Africa/Lagos",
        day: "numeric", month: "long", year: "numeric",
      })}
    />
  );

  // ⚠️ An HTTP header is a ByteString — every character must fit in one byte.
  // The obvious filename, `${org.name} — ${label} guide.pdf`, threw a 500 on
  // the em dash (U+2014) before a single byte of PDF reached the browser, and
  // an org named in any non-Latin-1 script would do the same. Verified against
  // the running route, not reasoned about: the PDF itself rendered perfectly in
  // a script, because a script never builds a header.
  //
  // So: a plain ASCII name for the header's own `filename`, and the real one in
  // RFC 5987 `filename*`, which every current browser prefers when both are
  // present. A reader that understands neither still gets a sensible file.
  const niceName = `${org.name} - ${label} guide.pdf`.replace(/[/\\?%*:|"<>]/g, "-");
  const asciiName = niceName.replace(/[^\x20-\x7E]/g, "").trim() || "role-guide.pdf";

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        `attachment; filename="${asciiName}"; ` +
        `filename*=UTF-8''${encodeURIComponent(niceName)}`,
      // Personal to the caller and cheap to regenerate — never let a shared
      // cache hold one person's copy and hand it to the next reader.
      "Cache-Control": "private, no-store",
    },
  });
}
