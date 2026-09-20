// The navigation search offers only what the role can already reach.
//
// Built 20 Sept 2026 after "Collections" could not be found: it lives at
// /dashboard/ledger/collections, is a TAB inside Client Funds, and appears in
// no sidebar. So the search covers the tab strips as well as the sidebar —
// which means this file has to hold two things honest at once.
//
// The claims that matter:
//   • ⚠️ searchDestinations NEVER returns a destination whose show(ctx) is
//     false, for every role. The filter runs BEFORE the match, so an
//     unauthorised destination is not merely hidden — it is never a candidate,
//     and so cannot be leaked by the SHAPE of the results either.
//   • a tenant, a vendor, a viewer and an ops-staff login cannot surface the
//     money screens, the directory, or the operator's org list by typing.
//   • the sub-destinations listed in nav-config AGREE with the tab strips that
//     actually render them — the drift guard that makes the duplication safe.
//   • searching "collections" finds Collections for a finance desk, which is
//     the regression that prompted the whole feature.
//
// Usage: npx tsx scripts/verify-nav-search.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV_GROUPS, reachableDestinations, searchDestinations } from "../components/shell/nav-config.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

// Every flag off; each role below turns on only its own.
//
// ⚠️ The flag list is READ OUT OF `NavContext`, not typed out here. Hand-listing
// it was wrong on the first attempt in both directions — seven invented names
// that match nothing, and two real ones missed (`reviewsVendorRegistrations`,
// `seesLettings`), which quietly excluded their destinations from the
// exhaustive check in A while it still reported PASS. A list of what exists is
// never written by hand next to the thing that defines it.
const navSrc = fs.readFileSync(path.join(rootDir, "components/shell/nav-config.ts"), "utf8");
const FLAGS = [
  ...navSrc
    .slice(navSrc.indexOf("export type NavContext = {"), navSrc.indexOf("export type NavChild"))
    .matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*boolean;/gm),
].map((m) => m[1]);

if (FLAGS.length < 20) {
  console.error(`Could not read NavContext's flags (found ${FLAGS.length}). This suite would test almost nothing.`);
  process.exit(1);
}

const base = () => Object.fromEntries(FLAGS.map((f) => [f, false]));
const ctxOf = (...on) => {
  const c = base();
  for (const f of on) {
    if (!FLAGS.includes(f)) {
      console.error(`"${f}" is not a NavContext flag — this role would test less than it claims.`);
      process.exit(1);
    }
    c[f] = true;
  }
  return c;
};

const ROLES = {
  tenant: ctxOf("isTenant"),
  vendor: ctxOf("isVendor"),
  viewer: ctxOf("isViewer"),
  opsStaff: ctxOf("isOpsStaff"),
  owner: ctxOf("isOwner"),
  moneyDesk: ctxOf("isMoneyDesk", "seesPayments", "seesApprovals"),
  financeAdmin: ctxOf("isStaff", "isAdmin", "seesLedger", "seesPayments", "canEnroll", "seesLettings"),
  regionalManager: ctxOf("isStaff", "isRegionalManager", "seesProperties", "seesAssets", "reviewsVendorRegistrations"),
  operatorAdmin: ctxOf("isStaff", "isAdmin", "isOperator", "canEnroll", "seesLedger"),
  // Every flag on at once. Not a real person — it exists so section A's sweep
  // has a context in which EVERY destination is reachable, which is what makes
  // "every label, against every role" actually cover every label.
  everything: ctxOf(...FLAGS),
};
console.log("Navigation search — it offers only what the role can reach\n");

// ── A. The invariant, exhaustively ────────────────────────────────────────
//
// Not a sample of queries: every destination's OWN label is searched against
// every role. If any role can surface any destination it may not reach, this
// finds it.
console.log("A. Nothing unreachable is ever returned");
{
  const everyLabel = [];
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      everyLabel.push(i.label);
      for (const c of i.children ?? []) everyLabel.push(c.label);
    }
  }

  let leaks = 0;
  let checks = 0;
  for (const [roleName, ctx] of Object.entries(ROLES)) {
    const allowed = new Set(reachableDestinations(ctx).map((h) => `${h.label}|${h.href}`));
    for (const label of everyLabel) {
      for (const hit of searchDestinations(ctx, label)) {
        checks++;
        if (!allowed.has(`${hit.label}|${hit.href}`)) {
          leaks++;
          bad(`${roleName} searching "${label}" was offered "${hit.label}" (${hit.href}) — which it cannot reach`);
        }
      }
    }
  }
  leaks === 0
    ? ok(`${checks} offered result(s) across ${Object.keys(ROLES).length} roles × ${everyLabel.length} labels — every one reachable`)
    : bad(`${leaks} leak(s)`);

  // Also by href, so a renamed label cannot smuggle one through.
  let hrefLeaks = 0;
  for (const [roleName, ctx] of Object.entries(ROLES)) {
    const allowedHrefs = new Set(reachableDestinations(ctx).map((h) => h.href));
    for (const g of NAV_GROUPS) {
      for (const i of g.items) {
        for (const hit of searchDestinations(ctx, i.href)) {
          if (!allowedHrefs.has(hit.href)) { hrefLeaks++; bad(`${roleName} reached ${hit.href} by href`); }
        }
      }
    }
  }
  hrefLeaks === 0 ? ok("searching by URL fragment leaks nothing either") : bad(`${hrefLeaks} href leak(s)`);
}

// ── B. The specific things these roles must never see ─────────────────────
console.log("\nB. The screens a tenant, vendor or viewer must not find");
{
  const FORBIDDEN = [
    ["tenant", ["ledger", "payouts", "directory", "permissions", "reconciliation", "orgs"]],
    ["vendor", ["ledger", "directory", "permissions", "reconciliation", "orgs"]],
    ["viewer", ["ledger", "payouts", "directory", "permissions", "orgs"]],
    ["opsStaff", ["ledger", "payouts", "directory", "permissions", "orgs"]],
  ];
  let bad_ = 0;
  for (const [role, terms] of FORBIDDEN) {
    for (const term of terms) {
      const hits = searchDestinations(ROLES[role], term);
      if (hits.length > 0) {
        bad_++;
        bad(`${role} searching "${term}" got ${hits.map((h) => h.label).join(", ")}`);
      }
    }
  }
  bad_ === 0 ? ok("none of the money, directory, permission or operator screens surface") : null;

  // The operator's org list is the sharpest case (decision 12).
  searchDestinations(ROLES.financeAdmin, "organisation").some((h) => h.href === "/orgs")
    ? bad("a NON-operator admin can find the operator's org list")
    : ok("a non-operator admin cannot find the operator org list — decision 12 holds in search too");
}

// ── C. The tab strips and nav-config must agree ───────────────────────────
//
// The duplication is deliberate (see NavChild), so it needs a guard. This is
// the same arrangement verify-bootstrap has with use-env.mjs, and for the same
// reason: two lists of one thing drift, and drift is silent.
console.log("\nC. Sub-destinations match the tab strips that render them");
{
  const STRIPS = [
    ["/dashboard/ledger", "app/dashboard/ledger/LedgerNav.tsx"],
    ["/dashboard/people", "app/dashboard/people/SubNav.tsx"],
    ["/dashboard/settings", "app/dashboard/settings/SettingsNav.tsx"],
  ];
  for (const [parentHref, file] of STRIPS) {
    const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.href === parentHref);
    if (!item) { bad(`no nav item for ${parentHref}`); continue; }
    const declared = new Set((item.children ?? []).map((c) => c.href));

    const src = fs.readFileSync(path.join(rootDir, file), "utf8");
    // Every href in the strip's own TABS array.
    const rendered = new Set(
      [...src.matchAll(/href:\s*"(\/dashboard\/[a-z/-]*)"/g)].map((m) => m[1])
    );

    const missing = [...rendered].filter((h) => !declared.has(h));
    const extra = [...declared].filter((h) => !rendered.has(h));
    missing.length === 0 && extra.length === 0
      ? ok(`${path.basename(file)} — ${rendered.size} tab(s), all listed for search`)
      : bad(
          `${path.basename(file)} disagrees with nav-config` +
          (missing.length ? `\n         not searchable: ${missing.join(", ")}` : "") +
          (extra.length ? `\n         searchable but not a tab: ${extra.join(", ")}` : "")
        );
  }
}

// ── D. The thing that prompted this ───────────────────────────────────────
console.log("\nD. The regression that started it");
{
  const hits = searchDestinations(ROLES.financeAdmin, "collections");
  hits.some((h) => h.href === "/dashboard/ledger/collections")
    ? ok(`a finance admin typing "collections" finds it (${hits[0].context} ${hits[0].label})`)
    : bad('a finance admin typing "collections" still cannot find it');

  searchDestinations(ROLES.financeAdmin, "coll")[0]?.href === "/dashboard/ledger/collections"
    ? ok('a prefix — "coll" — ranks Collections first')
    : bad('"coll" does not rank Collections first');

  searchDestinations(ROLES.tenant, "collections").length === 0
    ? ok("a tenant typing the same word finds nothing — and is told only that")
    : bad("a tenant can find Collections");

  searchDestinations(ROLES.financeAdmin, "").length === 0
    ? ok("an empty query returns nothing rather than the whole menu")
    : bad("an empty query returns results");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll navigation-search checks passed.\x1b[0m"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
