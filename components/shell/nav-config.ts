import {
  Inbox,
  LayoutDashboard,
  Building2,
  ReceiptText,
  Banknote,
  FileText,
  ShieldCheck,
  Settings,
  type LucideIcon,
} from "lucide-react";

// Role/permission context computed on the server (from the B7 matrix) and passed
// to the client shell, which filters the nav so each role sees only its own
// destinations.
export type NavContext = {
  isStaff: boolean;
  isAdmin: boolean;
  seesBi: boolean;
  seesAudit: boolean;
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
      { label: "Requests", href: "/dashboard", icon: Inbox, show: () => true },
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
      { label: "Statements", href: "/dashboard/statements", icon: FileText, show: () => true },
      {
        label: "Audit Trail",
        href: "/dashboard/audit",
        icon: ShieldCheck,
        show: (c) => c.seesAudit,
      },
      {
        label: "Settings",
        href: "/dashboard/settings",
        icon: Settings,
        show: (c) => c.isAdmin,
      },
    ],
  },
];

// Exact for the index route, prefix-match for nested routes.
export function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}
