// A vendor company gives its people a ROLE, and the role is a named set of the
// four fixed capabilities (0246 UI layer over decision 17).
//
// The claims that matter:
//   • the mapping is exactly what the board asked: member = the work, admin =
//     people + work + contracts, owner = all four
//   • admin deliberately does NOT include manage_profile — editing the
//     registration is editing evidence a managing organisation verified
//   • the deriver is exact, not "close enough": a set matching no preset reads
//     as `custom` and is never rounded to a role
//   • an owner reads as owner whatever their array says
//   • ⚠️ a vendor CANNOT make themselves or anyone else an owner — the database
//     admits only a holder of `vendors.write`
//   • every live membership still resolves to a role the screen can render
//
// Usage: node scripts/verify-vendor-roles.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  VENDOR_ROLE_CAPABILITIES,
  ASSIGNABLE_VENDOR_ROLES,
  vendorRoleOf,
  isAssignableVendorRole,
  capabilitiesForVendorRole,
} from "../lib/vendor-roles.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const note = (m) => console.log(`  \x1b[33mNOTE\x1b[0m ${m}`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// ── A ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§A The mapping the board asked for\x1b[0m");
same(VENDOR_ROLE_CAPABILITIES.member, ["manage_work"])
  ? ok("member = manage_work, and nothing about the company")
  : bad(`member = ${VENDOR_ROLE_CAPABILITIES.member.join(", ")}`);

same(VENDOR_ROLE_CAPABILITIES.admin, ["manage_users", "manage_work", "manage_contracts"])
  ? ok("admin = manage people + manage work + manage contracts")
  : bad(`admin = ${VENDOR_ROLE_CAPABILITIES.admin.join(", ")}`);

VENDOR_ROLE_CAPABILITIES.admin.includes("manage_profile")
  ? bad("admin holds manage_profile — editing the verified registration is the owner's")
  : ok("and NOT manage_profile — the registration stays with the owner");

VENDOR_ROLE_CAPABILITIES.member.every((c) => VENDOR_ROLE_CAPABILITIES.admin.includes(c))
  ? ok("admin is a superset of member — the ladder actually climbs")
  : bad("admin does not contain everything member does");

// ── B ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§B The deriver is exact\x1b[0m");
vendorRoleOf(false, ["manage_work"]) === "member" ? ok("{manage_work} reads as member") : bad("member not derived");
vendorRoleOf(false, ["manage_users", "manage_work", "manage_contracts"]) === "admin"
  ? ok("{users, work, contracts} reads as admin") : bad("admin not derived");
vendorRoleOf(true, []) === "owner"
  ? ok("an owner reads as owner even with an EMPTY array — vendor_user_can short-circuits on is_owner, and so does this")
  : bad("owner not derived from is_owner alone");
vendorRoleOf(false, ["manage_contracts"]) === "custom"
  ? ok("{manage_contracts} alone reads as custom — not rounded up to admin")
  : bad("a non-preset set was rounded to a role");
vendorRoleOf(false, ["manage_users", "manage_work", "manage_contracts", "manage_profile"]) === "custom"
  ? ok("all four WITHOUT is_owner is custom too — a superset is not admin")
  : bad("a superset was reported as admin");
vendorRoleOf(false, []) === "custom" ? ok("an empty set is custom, never a role") : bad("empty set derived a role");

// ── C ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§C Only two roles are assignable\x1b[0m");
isAssignableVendorRole("owner")
  ? bad("`owner` is assignable — a vendor must not be able to mint an owner")
  : ok("`owner` is NOT assignable from the vendor side");
["custom", "", "admin ", "ADMIN", null, undefined, 1].every((v) => !isAssignableVendorRole(v))
  ? ok("nothing else is accepted either — the set is closed")
  : bad("an unexpected value passed as a role");
ASSIGNABLE_VENDOR_ROLES.every((r) => capabilitiesForVendorRole(r).length > 0)
  ? ok("every assignable role grants at least one capability")
  : bad("a role grants nothing — an invitation with nothing to do");

// ── D ──────────────────────────────────────────────────────────────────────
//
// The control that matters. The UI no longer offers owner; this proves the
// DATABASE refuses it, so the guarantee does not depend on the screen.
console.log("\n\x1b[1m§D A vendor cannot make an owner\x1b[0m");

// ⚠️ Builds its own fixture rather than hunting for a usable pair among live
// rows. The first draft picked whatever non-owner it found, landed on a probe
// membership left by another suite whose password it did not know, and SKIPPED
// — reporting a NOTE where the control this whole change rests on should have
// been proved. A suite that can silently skip its own load-bearing check is
// worse than one that fails.
const { data: vu } = await svc
  .from("vendor_users").select("id, vendor_id, user_id, is_owner, capabilities, org_id");

const OWNER_EMAIL = "oea.vendor@oegroup.test";
const { data: ownerUser } = await svc
  .from("users").select("id, org_id").eq("email", OWNER_EMAIL).maybeSingle();
const ownerRow = ownerUser
  ? (vu ?? []).find((v) => v.user_id === ownerUser.id && v.is_owner)
  : null;

if (!ownerRow) {
  bad(`${OWNER_EMAIL} is not an owner of any vendor — the seed fixture moved`);
} else {
  const S = Date.now().toString(36).toUpperCase().slice(-5);
  const email = `proberole.colleague.${S}@oegroup.test`;
  const { data: created, error: mkErr } =
    await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (mkErr) {
    bad(`could not create the colleague fixture: ${mkErr.message}`);
  } else {
    await svc.from("users").upsert({
      id: created.user.id, org_id: ownerUser.org_id, email,
      full_name: `Probe Colleague ${S}`, role: "vendor",
    });
    const { data: membership } = await svc.from("vendor_users").insert({
      org_id: ownerRow.org_id, vendor_id: ownerRow.vendor_id,
      user_id: created.user.id, is_owner: false, capabilities: ["manage_work"],
    }).select("id").single();

    const c = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: authErr } = await c.auth.signInWithPassword({ email: OWNER_EMAIL, password: PW });
    if (authErr) {
      bad(`could not sign in as the vendor owner ${OWNER_EMAIL}: ${authErr.message}`);
    } else {
      const { error } = await c.from("vendor_users")
        .update({ is_owner: true }).eq("id", membership.id);
      error && /only the managing organisation/.test(error.message)
        ? ok("an owner promoting a colleague to owner is refused, by name")
        : bad(`promotion gave: ${error?.message ?? "NO ERROR — a vendor minted an owner"}`);

      const { error: selfErr } = await c.from("vendor_users")
        .update({ is_owner: false }).eq("id", ownerRow.id);
      selfErr
        ? ok("and an owner cannot resign their own ownership either — same rule, other direction")
        : bad("an owner demoted THEMSELVES, leaving ownership changeable from the vendor side");
      if (!selfErr) await svc.from("vendor_users").update({ is_owner: true }).eq("id", ownerRow.id);

      // The whole point of the split: roles move, ownership does not.
      const { error: capErr } = await c.from("vendor_users")
        .update({ capabilities: capabilitiesForVendorRole("admin") }).eq("id", membership.id);
      capErr
        ? bad(`the owner could not set a colleague's role: ${capErr.message}`)
        : ok("but they CAN set that colleague's role — capabilities move, ownership does not");

      const { data: after } = await svc.from("vendor_users")
        .select("is_owner, capabilities").eq("id", membership.id).single();
      vendorRoleOf(after.is_owner, after.capabilities) === "admin"
        ? ok("and the membership now reads back as admin")
        : bad(`reads back as ${vendorRoleOf(after.is_owner, after.capabilities)}, expected admin`);
    }

    await svc.from("vendor_users").delete().eq("id", membership.id);
    await svc.from("users").delete().eq("id", created.user.id);
    await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
  }
}

// ── E ──────────────────────────────────────────────────────────────────────
console.log("\n\x1b[1m§E Every live membership renders\x1b[0m");
const counts = {};
for (const v of vu ?? []) {
  const r = vendorRoleOf(v.is_owner, v.capabilities);
  counts[r] = (counts[r] ?? 0) + 1;
}
Object.entries(counts).forEach(([r, n]) => note(`${n} membership(s) read as ${r}`));
(vu ?? []).every((v) => ["owner", "admin", "member", "custom"].includes(vendorRoleOf(v.is_owner, v.capabilities)))
  ? ok(`all ${(vu ?? []).length} live memberships resolve to a role the screen can render`)
  : bad("a membership resolved to something the screen cannot render");
counts.custom
  ? note(`${counts.custom} predate roles and are left exactly as they are until someone picks one — not migrated, because rounding would silently change what a person may do`)
  : note("no custom memberships — every live row already matches a preset");

console.log(
  failures
    ? `\n\x1b[31m✖ ${failures} check(s) failed\x1b[0m`
    : "\n\x1b[32m✔ vendor roles: all checks passed\x1b[0m"
);
process.exit(failures ? 1 : 0);
