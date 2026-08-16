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
    //
    // The operator's own hostname is the one exception: its door is /login, not
    // /o/oe-group (0112) — that generic template is built for a client org's
    // front door, not the anonymous operator one.
    redirect(hostOrg.is_platform_operator ? "/login?wrong_org=1" : `/o/${hostOrg.slug}?wrong_org=1`);
  }
  const role = profile?.role ?? "member";
  // Brand-aware: OEA renders facility_manager as "Properties Manager".
  const label = roleLabel(role, org?.delivery_brand);

  // ⚠️ Read through `my_notifications()` (0145), NOT the table directly.
  //
  // The bell used to select `user_notifications` straight, which gave it no way
  // to know whether a link still points at anything — so it happily offered a
  // link to a deleted ticket, and clicking it 404ed. Fixing the inbox tab alone
  // would have moved that bug here rather than closing it, since the bell is
  // where most people click a notification from.
  //
  // The function also applies the retention rule (30 days, plus anything still
  // unread whatever its age), so the bell and the tab cannot disagree about
  // what exists.
  const supabase = await createClient();
  const { data: notifications } = await supabase.rpc("my_notifications", { p_days: 30 });

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
  // ⚠️ What the caller may DO comes from the matrix, not from an array here.
  //
  // Three times this session an application array of role names was found
  // disagreeing with the database: the executive locked out of the ledger they
  // are granted, the executive refused an approval decision 9 gives them, and
  // the **regional manager** — holding properties.write, assets.write,
  // tickets.assign, people.invite, vendors.write, leases.write and nine more —
  // appearing in none of these lists, so the product offered them no Properties,
  // Assets, Vendors, Leases or People at all.
  //
  // Decision 7 made privileges an operator-toggled matrix so role names would
  // stop being hardcoded. The menu kept its own copy anyway. It now asks
  // (`my_capabilities()`, 0132), so a capability the operator grants shows up
  // without a deployment.
  const { data: capsRow } = await supabase.rpc("my_capabilities");
  const caps: string[] = capsRow ?? [];
  const can = (c: string) => caps.includes(c);

  const ctx: NavContext = {
    // ⚠️ The NON-DELEGABLE controls stay role checks, and that is deliberate
    // (decision 7): payment approval, remittance, ledger, bank configuration,
    // audit visibility, admin invitation and permission editing "stay hardwired
    // and never appear as toggles" — they are what an auditor checks, not
    // preferences. `non_delegable_controls` lists them, so this is legible
    // rather than remembered.
    seesAudit: ["admin", "finance_approver", "executive"].includes(role),
    seesLedger: ["admin", "finance_approver", "executive"].includes(role),
    isAdmin: role === "admin",

    // Identity, not privilege — which home screen a person gets.
    isViewer: role === "viewer",
    isTenant: role === "tenant",
    isVendor: role === "vendor",
    // Dispatched internal staff. They hold no capability at all by design (B7
    // gives them "assigned work" and nothing else), so this cannot come from
    // the matrix — and they were the one role with somewhere to be sent and
    // nowhere to look.
    isOpsStaff: role === "fm_ops_staff",
    isOwner: role === "property_owner",

    // Capability-derived. `properties`/`vendors`/`leases` read as "can act on
    // them at all"; RLS then decides WHICH — an FM/PM and a regional manager
    // both reach the same screen and see their own scope.
    // ⚠️ `|| isOwner` is not an exception being smuggled back in — it is the
    // one access route the matrix genuinely cannot express. A landlord holds no
    // property or asset CAPABILITY (they hold `bi.read` and nothing else), and
    // reaches both tables by being a stakeholder on the property:
    // `properties_select` admits them, and the asset policy admits
    // `property_id in current_user_property_ids()`, which for an owner is their
    // own building. Deriving purely from capabilities would have taken away two
    // pages that work — a regression introduced by a cleanup, which is the
    // worst kind.
    seesProperties: can("properties.write") || can("properties.read_all") || role === "property_owner",
    seesAssets:
      can("assets.read") || can("assets.write") || can("assets.import") || role === "property_owner",
    seesVendors: can("vendors.read") || can("vendors.write"),
    seesLettings: can("leases.write") || can("applications.review_all") || can("applications.recommend"),
    seesServiceCharges: can("sc.read_all") || can("sc.manage"),
    // Vendor payments: FM/PM verifies delivery, finance and oversight decide.
    // Not capability-derived because approval is non-delegable, and a screen
    // whose only action is refused is worse than no screen.
    seesPayments: [
      "admin", "facility_manager", "finance_approver", "executive",
      // The two chain roles exist to look at payments; a payment approver who
      // cannot reach the payments screen is a role that cannot do its job.
      "payment_approver", "payment_audit_approver",
    ].includes(role),
    // Everyone who can action a stage, plus the roles that need to watch the
    // queue move. Same reasoning as seesPayments: not capability-derived,
    // because approval is non-delegable (decision 7).
    seesApprovals: [
      "admin", "executive", "facility_manager", "regional_manager",
      "payment_approver", "payment_audit_approver", "finance_approver",
    ].includes(role),
    canEnroll: can("people.invite"),

    // B7 "Exec / BI dashboard" column — one definition, shared with the pages
    // themselves so the link and the page can never disagree about who may look.
    seesBi: seesBi(role),
    seesRequestAnalytics: biScope(role).requests,

    // Everyone operational who is not given a personal home screen above.
    isStaff: ["admin", "facility_manager", "finance_approver", "executive", "regional_manager"].includes(role),
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
