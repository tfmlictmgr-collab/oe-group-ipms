/**
 * The rule behind `hostServesOrg` (lib/org-host.ts), kept free of request and
 * database imports so a suite can exercise it directly
 * (scripts/verify-public-pages-host-bound.mjs).
 *
 * An unbound host (null) may show any org's public page; a bound host only its
 * own. A missing org id on a bound host is refused, never waved through.
 */
export function hostAllowsOrg(hostOrgId: string | null, orgId: string | null | undefined): boolean {
  if (!hostOrgId) return true;
  return !!orgId && hostOrgId === orgId;
}
