import { redirect } from "next/navigation";
import { orgForCurrentHost } from "@/lib/org-host";
import SignInPanel from "@/components/auth/sign-in-panel";

// The **platform operator's** front door — OE Group's own staff, not a client's.
//
// Deliberately anonymous: it names no organisation and lists none, so loading it
// reveals nothing about who is on the platform (B1). An organisation's own people
// use its address instead — /o/<slug> — which carries that org's branding and,
// still, no mention of any other.
//
// Signing in here lands on the org launcher rather than a dashboard: the point of
// this door is to SEE the organisations and choose one, and the operator org holds
// no operational data of its own to show (0088). A tenant user who arrives here
// anyway is forwarded to their own dashboard by /orgs, which reveals nothing —
// they learn only that they are not an operator, which they already knew.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ wrong_org?: string; deactivated?: string }>;
}) {
  const { wrong_org, deactivated } = await searchParams;

  // The root page (`/`) already sends a bound client hostname straight to its
  // own door and never lands here. But `/login` is a URL of its own — bookmarked,
  // typed directly, or linked from an old message — and until this check it
  // rendered the operator's hardcoded OE Group screen on ANY host, including one
  // bound to a client. A TFML employee hitting tfmlportal.com/login saw OE
  // Group's name and colours on their own company's domain: the same cross-brand
  // leak the sign-in panel's `owner` prop exists to prevent, just reached by a
  // path that skipped the check. A client org's own door takes over here instead.
  const hostOrg = await orgForCurrentHost();
  if (hostOrg?.slug && !hostOrg.is_platform_operator) {
    redirect(`/o/${hostOrg.slug}`);
  }

  return (
    <SignInPanel
      redirectTo="/orgs"
      brand={{
        portalName: "OE Group",
        logoText: "OE",
        logoUrl: null,
        primary: "#003366",
        headline: "Facilities and property management, unified.",
        // Names no client, here of all places — this door is public and B1's
        // "or existence" rule is exactly what a client list in a tagline breaks.
        tagline:
          "One auditable workspace for requests, service charges, vendor performance and payments.",
        owner: "OE Group",
      }}
      // Mirrors /o/[slug]'s own wrong_org notice (dashboard's cross-org guard
      // sends the operator's own hostname here instead, 0112). Says only that a
      // sign-in is needed — the same reason /o/[slug] keeps this generic rather
      // than naming the org the stale session belonged to.
      // `deactivated` names the actual reason, because "please sign in" in
      // front of an account that can never sign in again is a loop with no
      // exit. It reveals nothing: the person holding this session already
      // authenticated as themselves, so being told their own account is closed
      // tells them only what they just experienced.
      notice={
        deactivated
          ? "This account has been deactivated. Please contact your administrator."
          : wrong_org
            ? "Please sign in to continue."
            : undefined
      }
    />
  );
}
