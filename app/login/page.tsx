import SignInPanel from "@/components/auth/sign-in-panel";

// The OE Group front door. Deliberately anonymous: it names no organisation and
// lists none, so loading it reveals nothing about who is on the platform (B1).
// An organisation's own people use its address instead — /o/<slug> — which
// carries that org's branding and, still, no mention of any other.
export default function LoginPage() {
  return (
    <SignInPanel
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
