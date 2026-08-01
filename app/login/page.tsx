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
export default function LoginPage() {
  return (
    <SignInPanel
      redirectTo="/orgs"
      brand={{
        portalName: "OE Group",
        logoText: "OE",
        logoUrl: null,
        primary: "#003366",
        headline: "Facilities and property management, unified.",
        tagline:
          "One auditable workspace for requests, service charges, vendor performance and payments — across TFML and OEA.",
      }}
    />
  );
}
