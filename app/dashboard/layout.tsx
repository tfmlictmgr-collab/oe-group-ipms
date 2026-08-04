import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { orgForCurrentHost } from "@/lib/org-host";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/shell/app-shell";
import { roleLabel } from "@/lib/roles";
import type { NavContext } from "@/components/shell/nav-config";
import { seesBi, biScope } from "./bi/scope";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  const { profile, org, theme } = session;

  // ── A brand's hostname shows that brand's people, and nobody else ────────
  //
  // Defence in depth behind the sign-in check. A session can reach a dashboard
  // without passing through this deployment's login form at all — a cookie set
  // on a shared parent domain, a link opened in a browser already signed in
  // elsewhere — and none of those routes touch the panel's check.
  //
  // ⚠️ Deliberately FREE at page-load time. `orgForCurrentHost()` is cached per
  // host and `profile` is already in hand for the shell, so this is a string
  // comparison, not a query. An unbound host (localhost, *.vercel.app, the
  // operator's own domain) returns null and nothing is enforced — the platform
  // door is meant to serve everyone.
  const hostOrg = await orgForCurrentHost();
  if (hostOrg && profile?.org_id && profile.org_id !== hostOrg.id) {
    // ⚠️ Audit 0804 C2. End the session, don't just move the browser.
    //
    // `sign-in-panel.tsx` signs out on exactly this mismatch; this sibling only
    // redirected, leaving a live session for the other org's portal sitting in a
    // cookie on this host. No data was exposed — RLS scopes every read to the
    // user's own org whatever hostname they arrived on — but a redirect that
    // leaves the session standing is a bounce, not a boundary, and the two
    // checks disagreeing about that is how one of them later gets relaxed.
    const supabaseAuth = await createClient();
    await supabaseAuth.auth.signOut();

    // Back to the door they knocked on, which will refuse them by name. Not to
    // their OWN portal: this deployment should not tell one client's browser
    // where another client's portal lives.
    redirect(`/o/${hostOrg.slug}?wrong_org=1`);
  }
  const role = profile?.role ?? "member";
  // Brand-aware: OEA renders facility_manager as "Properties Manager".
  const label = roleLabel(role, org?.delivery_brand);

  // RLS restricts this to the caller's own rows — no role logic needed here.
  const supabase = await createClient();
  const { data: notifications } = await supabase
    .from("user_notifications")
    .select("id, kind, title, body, link, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  // A viewer is outside the organisation, so it is listed in none of the sets
  // below rather than added to any of them. The nav is presentation; RLS is what
  // actually decides, and 0038 grants a viewer no policy on any of these tables.
  // ⚠️ `executive` belongs in the READ sets below and in none of the write ones.
  //
  // The database already settled this and the nav had not caught up. `0072a`
  // put the executive into `oversight_roles()`, which grants them audit_log,
  // ledger and bank_accounts reads; `biScope()` gives them every BI column
  // ("All (RT)", B7 v3.3); `enforce_payment_transition()` lets them co-approve
  // a payment, including above the threshold. Yet every one of the flags here
  // omitted them — so an MD could authorise a disbursement they were not shown
  // the ledger for, and audit a trail whose link they could not see. The policy
  // said oversight; the menu said no such person.
  //
  // What stays closed stays closed, and for a stated reason each time:
  // `canEnroll` is enrolment (a write), `isOperator` is governance of OTHER
  // organisations, and remittance is refused in the database itself — an
  // executive may authorise money and may never move it (board, 29 Jul 2026).
  const ctx: NavContext = {
    isStaff: ["admin", "facility_manager", "finance_approver", "executive"].includes(role),
    isAdmin: role === "admin",
    isViewer: role === "viewer",
    isTenant: role === "tenant",
    isVendor: role === "vendor",
    seesAudit: ["admin", "finance_approver", "executive"].includes(role),
    // B7 "Exec / BI dashboard" column — one definition, shared with the pages
    // themselves so the link and the page can never disagree about who may look.
    seesBi: seesBi(role),
    seesRequestAnalytics: biScope(role).requests,
    seesAssets: ["admin", "facility_manager", "finance_approver", "property_owner", "executive"].includes(role),
    canEnroll: ["admin", "facility_manager"].includes(role),
    seesLedger: ["admin", "finance_approver", "executive"].includes(role),
    // Administrator of the platform operator org. Asked of the org record
    // rather than inferred from the role, because "admin" means admin of YOUR
    // org — every brand has one, and only one org is the operator.
    isOperator: role === "admin" && Boolean(org?.is_platform_operator),
  };

  return (
    <div
      style={
        {
          "--brand": theme.primary,
          "--brand-fg": theme.primaryForeground,
          "--brand-accent": theme.accent,
        } as React.CSSProperties
      }
    >
      <AppShell
        brandName={theme.name}
        orgName={org?.name ?? theme.name}
        logoText={theme.logoText}
        logoUrl={theme.logoUrl}
        portalName={theme.portalName}
        supportEmail={theme.supportEmail}
        supportPhone={theme.supportPhone}
        user={{
          name: profile?.full_name ?? profile?.email ?? "",
          email: profile?.email ?? "",
          roleLabel: label,
        }}
        ctx={ctx}
        notifications={notifications ?? []}
      >
        {children}
      </AppShell>
    </div>
  );
}
