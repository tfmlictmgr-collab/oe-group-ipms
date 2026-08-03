import {
  Inbox,
  Package,
  LayoutDashboard,
  Building2,
  Building,
  ReceiptText,
  Banknote,
  Scale,
  FileText,
  ShieldCheck,
  Settings,
  UserPlus,
  LayoutGrid,
  FileSignature,
  SlidersHorizontal,
  HardHat,
  type LucideIcon,
} from "lucide-react";

// Role/permission context computed on the server (from the B7 matrix) and passed
// to the client shell, which filters the nav so each role sees only its own
// destinations.
export type NavContext = {
  isStaff: boolean;
  isAdmin: boolean;
  /**
   * A read-only observer from outside the organisation.
   *
   * Given ONE destination rather than degraded versions of several. The
   * operational screens read tables a viewer has no policy on — the requests
   * list would be empty, and the analytics page would render a financial
   * dashboard of ₦0, which reads as "the build is broken" rather than "you may
   * not see this". A single honest page beats four that half-work.
   */
  isViewer: boolean;
  /**
   * A resident/occupant.
   *
   * Given the request TRACKER rather than the operational requests list — the
   * two would show the same rows (RLS narrows both to their own), and offering
   * both under different names invites the reader to believe one is holding
   * something back.
   */
  isTenant: boolean;
  /** A contractor. Gets their own jobs, score and pay status — B7's vendor row. */
  isVendor: boolean;
  seesBi: boolean;
  /** The `requests` capability of the B7 BI matrix — the analytics console. */
  seesRequestAnalytics: boolean;
  seesAudit: boolean;
  /** Asset register readers: admin, FM/PM, finance, owners. */
  seesAssets: boolean;
  /** Enrolment is an admin / FM-PM responsibility. */
  canEnroll: boolean;
  /** The client-funds ledger is finance + admin only. */
  seesLedger: boolean;
  /**
   * An administrator of the platform operator org — the only person who may see
   * that other organisations exist (decision 12).
   *
   * ⚠️ This is presentation only, and deliberately so: `operator_org_directory()`
   * gates on `caller_is_operator_admin()` INSIDE the query, so a brand admin who
   * reached /orgs by typing the URL gets an empty set rather than a refusal — a
   * refusal confirms there is something worth refusing. Hiding the link is a
   * courtesy; the function is the boundary.
   */
  isOperator: boolean;
};

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  show: (ctx: NavContext) => boolean;
};

export type NavGroup = { heading: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      {
        label: "Programme Overview",
        href: "/dashboard/overview",
        icon: LayoutDashboard,
        show: (c) => c.isViewer,
      },
      {
        label: "My Requests",
        href: "/dashboard/my-requests",
        icon: Inbox,
        show: (c) => c.isTenant,
      },
      {
        label: "My Work",
        href: "/dashboard/my-work",
        icon: HardHat,
        show: (c) => c.isVendor,
      },
      {
        label: "Requests",
        href: "/dashboard",
        icon: Inbox,
        show: (c) => !c.isViewer && !c.isTenant && !c.isVendor,
      },
      {
        label: "Analytics",
        href: "/dashboard/bi",
        icon: LayoutDashboard,
        show: (c) => c.seesBi,
      },
      {
        label: "Analytics Console",
        href: "/dashboard/bi/analytics",
        icon: SlidersHorizontal,
        // The ops half of BI. A finance approver's dashboard is the money
        // columns; a console of ticket turnaround is not theirs (B7).
        show: (c) => c.seesRequestAnalytics,
      },
    ],
  },
  {
    heading: "Operations",
    items: [
      {
        label: "Properties",
        href: "/dashboard/properties",
        icon: Building,
        // Everyone operational: RLS decides WHICH properties come back, so an
        // FM/PM sees the ones they are attached to and nothing else.
        show: (c) => c.isStaff || c.seesAssets,
      },
      {
        label: "Assets",
        href: "/dashboard/assets",
        icon: Package,
        show: (c) => c.seesAssets,
      },
      {
        label: "Vendors",
        href: "/dashboard/vendors",
        icon: Building2,
        show: (c) => c.isStaff,
      },
      {
        label: "Leases & Rent",
        href: "/dashboard/leases",
        icon: FileSignature,
        // Lettings is OEA-only (B9), and the page itself says so for an org
        // without the module — shown to operational staff, scoped by RLS.
        show: (c) => c.isStaff,
      },
      {
        label: "Service Charges",
        href: "/dashboard/sc",
        icon: ReceiptText,
        show: (c) => c.isStaff,
      },
      {
        label: "Client Funds",
        href: "/dashboard/ledger",
        icon: Scale,
        show: (c) => c.seesLedger,
      },
      {
        label: "Payments",
        href: "/dashboard/payments",
        icon: Banknote,
        show: (c) => c.isStaff,
      },
    ],
  },
  {
    heading: "Operator",
    items: [
      {
        // The org launcher. Built on Day 8.8 and — until now — linked from
        // nowhere at all, so the only way to reach it was to type the URL. A
        // route no journey leads to is not a shipped feature.
        label: "Organisations",
        href: "/orgs",
        icon: LayoutGrid,
        show: (c) => c.isOperator,
      },
    ],
  },
  {
    heading: "Records",
    items: [
      { label: "Statements", href: "/dashboard/statements", icon: FileText, show: (c) => !c.isViewer },
      {
        label: "Audit Trail",
        href: "/dashboard/audit",
        icon: ShieldCheck,
        show: (c) => c.seesAudit,
      },
      {
        label: "People",
        href: "/dashboard/people",
        icon: UserPlus,
        show: (c) => c.canEnroll,
      },
      {
        // Open to everyone: personal notification preferences live here. The
        // organisation-configuration tabs inside are filtered by role, and each
        // re-checks server-side.
        label: "Settings",
        href: "/dashboard/settings",
        icon: Settings,
        // A viewer still has their own notification preferences to manage; the
        // organisation-configuration tabs inside are role-filtered and each
        // re-checks server-side.
        show: () => true,
      },
    ],
  },
];

// Exact for the index route, prefix-match for nested routes.
export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}
