// Pure org/brand header utilities — no framework imports, so this is directly
// unit-testable. The middleware uses these to stamp the SIGNED-JWT claim onto
// the forwarded request while guaranteeing no client-supplied value survives.

export const ORG_HEADER = "x-org-id";
export const BRAND_HEADER = "x-delivery-brand";
export const ROLE_HEADER = "x-user-role";

export type OrgClaim = {
  orgId?: string | null;
  brand?: string | null;
  role?: string | null;
};

// ALWAYS strips the three trust headers first (anti-spoof), then sets each only
// when the claim provides it. Mutates `h` in place.
export function applyTrustedOrgHeaders(h: Headers, claim: OrgClaim): void {
  h.delete(ORG_HEADER);
  h.delete(BRAND_HEADER);
  h.delete(ROLE_HEADER);
  if (claim.orgId) h.set(ORG_HEADER, String(claim.orgId));
  if (claim.brand) h.set(BRAND_HEADER, String(claim.brand));
  if (claim.role) h.set(ROLE_HEADER, String(claim.role));
}
