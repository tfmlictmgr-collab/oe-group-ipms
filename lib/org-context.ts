import { headers } from "next/headers";
import { ORG_HEADER, BRAND_HEADER, ROLE_HEADER, type OrgClaim } from "./org-headers";

// The trusted brand/org layer (B1 "API middleware"). The middleware reads the
// caller's org, brand and role from the SIGNED JWT (app_metadata) and stamps
// them onto the forwarded request headers, after first deleting any the client
// tried to send. So downstream server code can trust these headers: they either
// come from the verified token or are absent — never client-controlled.
//
// This is defense-in-depth. RLS (current_user_org_id) remains the enforced
// isolation backstop; a route that additionally checks the brand here fails
// safe even if it forgets an RLS-scoped query.

export { ORG_HEADER, BRAND_HEADER, ROLE_HEADER } from "./org-headers";
export { applyTrustedOrgHeaders, type OrgClaim } from "./org-headers";

// Server-side read of the trusted context (server components / route handlers).
export function orgContext(): OrgClaim {
  const h = headers();
  return {
    orgId: h.get(ORG_HEADER),
    brand: h.get(BRAND_HEADER),
    role: h.get(ROLE_HEADER),
  };
}
