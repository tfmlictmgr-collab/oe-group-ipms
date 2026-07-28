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
  seesBi: boolean;
  seesAudit: boolean;
  /** Asset register readers: admin, FM/PM, finance, owners. */
  seesAssets: boolean;
  /** Enrolment is an admin / FM-PM responsibility. */
  canEnroll: boolean;
  /** The client-funds ledger is finance + admin only. */
  seesLedger: boolean;
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
      { label: "Requests", href: "/dashboard", icon: Inbox, show: (c) => !c.isViewer },
      {
        label: "Analytics",
        href: "/dashboard/bi",
        icon: LayoutDashboard,
        show: (c) => c.seesBi,
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
