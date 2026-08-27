import {
  Inbox,
  Package,
  LayoutDashboard,
  Building2,
  Building,
  Receipt,
  ReceiptText,
  Banknote,
  Stamp,
  Scale,
  FileText,
  ShieldCheck,
  Settings,
  UserPlus,
  LayoutGrid,
  Layers,
  FileSignature,
  SlidersHorizontal,
  HardHat,
  Wrench,
  Landmark,
  type LucideIcon,
  ClipboardCheck,
  BookOpen,
  GraduationCap,
} from "lucide-react";

// Role/permission context computed on the server (from the B7 matrix) and passed
// to the client shell, which filters the nav so each role sees only its own
// destinations.
export type NavContext = {
  /**
   * Operational staff who get the shared requests list as their home screen —
   * everyone not given a personal one (tenant, vendor, viewer, ops staff).
   */
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
  /**
   * Dispatched internal staff.
   *
   * B7 gives them "assigned (RT)" and "own dispatched job cards (RT)" and
   * nothing else — so they hold no capability in the matrix at all, and this
   * flag cannot be derived from it. They were the one role with somewhere to be
   * SENT and nowhere to LOOK: `assignTicket` offers them, RLS lets them read
   * what they are given, and the navigation had no entry for it.
   */
  isOpsStaff: boolean;
  /**
   * A landlord.
   *
   * Given a portfolio home rather than the shared requests list, because the
   * Statements screen branches on staff-vs-not and an owner is not staff — so
   * they were shown the TENANT statement, service charges billed TO them. An
   * owner is not billed; they are paid.
   */
  isOwner: boolean;
  /** Decision 9: "Nothing financial, no org-wide read." */
  isRegionalManager: boolean;
  seesBi: boolean;
  /** The `requests` capability of the B7 BI matrix — the analytics console. */
  seesRequestAnalytics: boolean;
  seesAudit: boolean;
  /**
   * ⚠️ The flags below are derived from the OPERATOR-GOVERNED MATRIX
   * (`my_capabilities()`), not from arrays of role names.
   *
   * They used to be arrays here, and the arrays drifted: the regional manager
   * holds fifteen capabilities — properties.write, assets.write,
   * tickets.assign, people.invite, vendors.write, leases.write among them — and
   * was named in none of them, so the product offered them no destination for
   * any of it. Decision 7 made privileges a matrix so role names would stop
   * being hardcoded; this is the menu finally honouring that.
   */
  seesProperties: boolean;
  seesAssets: boolean;
  seesVendors: boolean;
  /**
   * May VERIFY a contractor's registration pack, not merely read the vendor
   * list. `vendors.write` — the same capability that governs adding a vendor at
   * all — so this is deliberately narrower than `seesVendors`, which is
   * satisfied by read alone.
   */
  reviewsVendorRegistrations: boolean;
  seesLettings: boolean;
  seesServiceCharges: boolean;
  /**
   * `training.read` (0203) — off by default for every role, including admin,
   * in every organisation. Deliberately unlike every other nav link on this
   * screen: the handbook ships with the release, and an operator turns it on
   * per org once that org's own content has been reviewed, rather than every
   * client seeing it appear unannounced on deploy day.
   */
  seesTraining: boolean;
  /** Vendor payments. Not capability-derived: approval is non-delegable. */
  seesPayments: boolean;
  /** The approval queue for outbound payments (0151). Non-delegable likewise. */
  seesApprovals: boolean;
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
        label: "My Rent",
        href: "/dashboard/my-rent",
        icon: Receipt,
        show: (c) => c.isTenant,
      },
      {
        label: "My Work",
        href: "/dashboard/my-work",
        icon: HardHat,
        show: (c) => c.isVendor,
      },
      {
        // The contractor's own company: registration, documents, and who at
        // the company may do what (decision 17). Shown to every vendor login —
        // the page itself distinguishes an owner from a colleague, because
        // reading is company-wide and only ACTING needs a capability.
        label: "My Company",
        href: "/dashboard/my-company",
        icon: Building2,
        show: (c) => c.isVendor,
      },
      {
        label: "My Jobs",
        href: "/dashboard/my-jobs",
        icon: Wrench,
        show: (c) => c.isOpsStaff,
      },
      {
        label: "My Portfolio",
        href: "/dashboard/portfolio",
        icon: Landmark,
        show: (c) => c.isOwner,
      },
      {
        label: "Requests",
        href: "/dashboard",
        icon: Inbox,
        show: (c) => !c.isViewer && !c.isTenant && !c.isVendor && !c.isOpsStaff,
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
        // RLS decides WHICH properties come back, so an FM/PM and a regional
        // manager reach the same screen and each sees their own scope.
        show: (c) => c.seesProperties || c.seesAssets,
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
        show: (c) => c.seesVendors,
      },
      {
        // The staff side of decision 17: packs a contractor has sent in.
        // `vendors.write` is what governs verifying one — the same capability
        // that governs adding a vendor at all — so this appears for the people
        // who would be doing the verifying and nobody else.
        label: "Registrations",
        href: "/dashboard/vendors/registrations",
        icon: ClipboardCheck,
        show: (c) => c.reviewsVendorRegistrations,
      },
      {
        label: "Leases & Rent",
        href: "/dashboard/leases",
        icon: FileSignature,
        // Lettings is OEA-only (B9), and the page itself says so for an org
        // without the module — scoped by RLS beyond that.
        show: (c) => c.seesLettings,
      },
      {
        label: "Service Charges",
        href: "/dashboard/sc",
        icon: ReceiptText,
        // ⚠️ Not shown to a regional manager, and that is the point of deriving
        // this from the matrix: decision 9 gives them everything operational a
        // FM/PM holds and "nothing financial". They hold no `sc.*` capability,
        // so this stays hidden without anyone maintaining an exclusion list.
        show: (c) => c.seesServiceCharges,
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
        show: (c) => c.seesPayments,
      },
      {
        label: "Approvals",
        href: "/dashboard/approvals",
        icon: Stamp,
        show: (c) => c.seesApprovals,
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
      {
        // The consolidated position across every client org. Operator-only for
        // the same reason the directory above is: it is one figure built from
        // several organisations' books, which is precisely what B1 keeps apart.
        // The link is a courtesy; `operator_consolidated_position()` gates
        // inside its own query and returns an empty set to anyone else.
        label: "Consolidated",
        href: "/orgs/consolidated",
        icon: Layers,
        show: (c) => c.isOperator,
      },
    ],
  },
  {
    heading: "Records",
    items: [
      {
        label: "Statements",
        href: "/dashboard/statements",
        icon: FileText,
        // ⚠️ NOT a vendor, and not ops/dispatched staff either. This screen is
        // a SERVICE-CHARGE statement — what is billed to your unit — and
        // neither a contractor nor internal dispatched staff has a unit, so
        // each was shown an empty statement for charges that could never
        // exist. Same fault, found a second time: `isStaff` on the page itself
        // is `["admin","facility_manager","finance_approver","executive"]`,
        // which never included `fm_ops_staff` either, so they fell into the
        // same tenant-billed branch a vendor did.
        //
        // Exactly the fault already fixed once for landlords (see `isOwner`
        // above): the page branches staff-vs-not, and everyone on the "not"
        // side was assumed to be billed. A contractor is PAID, not billed; an
        // ops staff member is neither billed nor paid through this screen —
        // their money, where relevant, lives elsewhere.
        show: (c) => !c.isViewer && !c.isVendor && !c.isOpsStaff && !c.isRegionalManager,
      },
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
        // Every role, without exception. The guide is written per role and is
        // resolved from the reader's own profile, so "show it to everyone" here
        // does not mean everyone sees the same document — a tenant cannot reach
        // the administrator's handbook by finding this link.
        label: "Guide",
        href: "/dashboard/guide",
        icon: BookOpen,
        show: () => true,
      },
      {
        // The trainer's handbook, not the learner's. Gated on `training.read`
        // (0203) rather than `isAdmin` alone — it ships OFF for every
        // organisation, including the operator's own, until OE Group turns it
        // on per org. The page and the API route both re-check the same
        // capability server-side; this is presentation, not the boundary.
        label: "Training",
        href: "/dashboard/training",
        icon: GraduationCap,
        show: (c) => c.seesTraining,
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
