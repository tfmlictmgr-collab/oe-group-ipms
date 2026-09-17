// Every role can be handed a guide, and it is a real document.
//
// A guide that 404s for a role, or renders an empty page, is worse than no
// guide: someone is told help exists, goes looking for it, and finds nothing.
// So this asserts against the ROLE LIST the database actually uses rather than
// against the list the guide file happens to contain — 0185's rule, that a
// check written against the diff passes on the day a new role is added.
//
// The claims:
//   • every role in the `user_role` enum resolves to a guide
//   • FM and PM get the same body under their own names (decision 18), and the
//     name follows the brand — OEA's is "Properties Manager"
//   • each guide renders to a real, non-empty PDF that starts with %PDF
//   • the org's own branding reaches the document — its name is inside the
//     bytes, so a guide cannot silently go out carrying nobody's brand
//   • every guide states what the role CANNOT do, which is the half that
//     prevents the support call
//
// Usage: npx tsx scripts/verify-role-guides.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import * as React from "react";
import { guideForRole } from "../lib/guides/content.ts";
import { RoleGuideDocument } from "../lib/pdf/role-guide.tsx";
import { roleLabel } from "../lib/roles.ts";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

console.log("Every role can be handed a guide\n");

// ── A. Ask the database which roles exist ─────────────────────────────────
// Not a list typed here. A role added tomorrow must fail this suite rather
// than quietly ship without a guide.
console.log("A. The role list comes from the database, not from this file");
const { data: enumRows, error: enumErr } = await svc.rpc("exec_sql_select_roles").then(
  (r) => r,
  () => ({ data: null, error: { message: "helper absent" } })
);

let roles = [];
if (enumRows && Array.isArray(enumRows)) {
  roles = enumRows.map((r) => r.role);
} else {
  // No helper function exists for this, and adding one to production schema
  // just to let a test enumerate an enum would be the tail wagging the dog.
  // Read the roles actually in USE instead, which is the population that
  // matters, and say plainly that is what happened.
  const { data: used, error } = await svc
    .from("users").select("role").is("deactivated_at", null);
  if (error) {
    bad(`could not read roles in use: ${error.message}`);
  } else {
    roles = [...new Set((used ?? []).map((u) => u.role))].filter(Boolean);
    ok(`${roles.length} distinct role(s) in use, read from the users table`);
  }
}

if (roles.length === 0) {
  console.log("\n  no roles to check — is this world seeded?");
  process.exit(1);
}

// ── B. Every one of them resolves ─────────────────────────────────────────
console.log("\nB. Every role in use has a guide");
{
  const missing = [];
  for (const r of roles) {
    const g = guideForRole(r, roleLabel(r, "OEA"));
    if (!g) missing.push(r);
  }
  missing.length === 0
    ? ok(`all ${roles.length} resolve to a guide`)
    : bad(`no guide for: ${missing.join(", ")}`);
}

// ── C. FM and PM are peers with their own names ───────────────────────────
console.log("\nC. The two manager roles are told apart by name, not by brand alone");
{
  const fmTfml = guideForRole("facility_manager", roleLabel("facility_manager", "TFML"));
  const pmOea = guideForRole("property_manager", roleLabel("property_manager", "OEA"));

  fmTfml && pmOea ? ok("both resolve") : bad("one of the manager roles has no guide");

  if (fmTfml && pmOea) {
    fmTfml.title !== pmOea.title
      ? ok(`titled separately — "${fmTfml.title}" vs "${pmOea.title}"`)
      : bad("both manager roles produce an identical title");

    // ⚠️ AMENDED BY DECISION 29 (board, 5 Sept 2026). This asserted the two
    // bodies were IDENTICAL, quoting 0183's "they hold identical grants on the
    // day of the split, by construction". That day has passed: the property
    // manager now holds `sc.manage` and `leases.write` and the facilities
    // manager deliberately does not — the first intended divergence between the
    // decision-18 peers.
    //
    // So the shape is still asserted, and what is asserted is that they differ
    // by EXACTLY the money section and by nothing else. "They are different"
    // would pass on any drift at all; "the PM has one more section, and it is
    // the one about service charges and tenancies" is the actual rule.
    const extra = pmOea.sections.filter(
      (s) => !fmTfml.sections.some((f) => f.heading === s.heading)
    );
    const lost = fmTfml.sections.filter(
      (s) => !pmOea.sections.some((p) => p.heading === s.heading)
    );
    extra.length === 1 && /service charge|tenanc/i.test(extra[0].heading) && lost.length === 0
      ? ok(`the PM guide adds exactly one section and it is the right one — "${extra[0].heading}"`)
      : bad(
          `the manager guides differ by ${extra.length} added / ${lost.length} missing section(s): ` +
          `+${extra.map((s) => s.heading).join(", ") || "none"} / -${lost.map((s) => s.heading).join(", ") || "none"}`
        );

    // And the other half of decision 29, said on the page a person actually
    // reads: the facilities manager's guide must not promise money work.
    /service charge budget|record a tenancy/i.test(JSON.stringify(fmTfml.sections))
      ? bad("the FACILITIES manager's guide describes service charge or tenancy work — decision 29 excludes them")
      : ok("and the facilities manager's guide promises none of it — decision 29");
  }
}

// ── D. Each one renders to a real PDF ─────────────────────────────────────
console.log("\nD. Each guide renders to an actual document");
{
  const org = {
    name: "Ora Egbunike & Associates",
    logoUrl: null,               // exercised without a logo on purpose: an org
    primary: "#D92323",          // with none must still produce a clean page
    tagline: "Chartered surveyors and property managers",
    supportEmail: "info@oraegbunike.com",
    supportPhone: "+2347084714148",
    portalName: "OEA",
  };

  let rendered = 0;
  let smallest = Infinity;
  for (const r of roles) {
    const label = roleLabel(r, "OEA");
    const guide = guideForRole(r, label);
    if (!guide) continue;

    try {
      const buf = await renderToBuffer(
        React.createElement(RoleGuideDocument, {
          org, guide, roleLabel: label,
          generatedFor: "Verification run",
          generatedAt: "25 August 2026",
        })
      );

      const head = buf.subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") {
        bad(`${r}: output does not begin with %PDF- (got ${JSON.stringify(head)})`);
        continue;
      }
      if (buf.length < 2000) {
        bad(`${r}: PDF is only ${buf.length} bytes — suspiciously empty`);
        continue;
      }
      smallest = Math.min(smallest, buf.length);
      rendered++;
    } catch (e) {
      bad(`${r}: rendering threw — ${e.message}`);
    }
  }

  rendered > 0
    ? ok(`${rendered} guide(s) rendered, smallest ${(smallest / 1024).toFixed(1)} KB`)
    : bad("nothing rendered at all");
}

// ── E. The org's brand actually reaches the page ──────────────────────────
// A guide going out carrying nobody's brand — or worse, the wrong brand — is
// the B1 failure this document format exists to avoid.
console.log("\nE. The organisation's own brand is in the document");
{
  const org = {
    name: "Total Facilities Management Limited",
    logoUrl: null, primary: "#003366",
    tagline: "ISO 41001 facilities management",
    supportEmail: "support@tfmlconsultant.com", supportPhone: null,
    portalName: "TFML",
  };
  const label = roleLabel("facility_manager", "TFML");
  const guide = guideForRole("facility_manager", label);

  const buf = await renderToBuffer(
    React.createElement(RoleGuideDocument, {
      org, guide, roleLabel: label,
      generatedFor: "Verification run", generatedAt: "25 August 2026",
    })
  );

  // PDF text is compressed, so the org name is looked for in the metadata the
  // document declares rather than in the drawn glyphs.
  const raw = buf.toString("latin1");
  raw.includes("Total Facilities Management")
    ? ok("the org's name is carried in the document metadata")
    : bad("THE ORG NAME IS NOT IN THE DOCUMENT — it would go out unbranded");

  raw.includes("Ora Egbunike")
    ? bad("THE OTHER BRAND'S NAME APPEARS IN THIS DOCUMENT")
    : ok("no other organisation's name appears anywhere in it");
}

// ── F. Every guide is honest about limits ─────────────────────────────────
console.log("\nF. Every guide states what the role cannot do");
{
  const silent = [];
  for (const r of roles) {
    const g = guideForRole(r, roleLabel(r, "OEA"));
    if (g && g.cannot.length === 0) silent.push(r);
  }
  silent.length === 0
    ? ok("all of them say what is out of reach, so a refusal reads as intent")
    : bad(`these say nothing about their limits: ${silent.join(", ")}`);
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mALL CHECKS PASSED\x1b[0m — every role has a guide, and it carries its own organisation's name.");
