// Whether an address can be used where mail must actually arrive — a payment
// gateway receipt, an invitation, a remittance advice.
//
// This is not "is it a valid email". Plenty of syntactically perfect addresses
// are guaranteed undeliverable, and the reserved TLDs in RFC 2606 / RFC 6761
// exist precisely so they never resolve. Paystack refuses them outright with
// "Invalid Email Address Passed" — which, arriving as a gateway error mid
// checkout, tells a finance user nothing about what to do.
//
// Returns a plain-language reason, or null when the address is usable.

const RESERVED_TLDS = ["test", "example", "invalid", "localhost", "local"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

export function unusableForCheckout(email: string | null | undefined): string | null {
  const value = (email ?? "").trim().toLowerCase();
  if (!value) return "no email address is recorded for them";

  // Deliberately loose: the gateway is the authority on syntax. This only
  // catches the shapes that are certainly wrong.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `"${email}" is not a valid email address`;

  const domain = value.slice(value.lastIndexOf("@") + 1);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);

  if (RESERVED_DOMAINS.includes(domain)) {
    return `"${domain}" is a documentation-only domain that cannot receive mail`;
  }
  if (RESERVED_TLDS.includes(tld)) {
    return `".${tld}" is a reserved domain that can never receive mail`;
  }
  return null;
}
