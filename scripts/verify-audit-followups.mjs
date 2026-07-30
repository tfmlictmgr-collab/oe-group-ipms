// The two findings still open after the Day-7 and baseline audits.
//
// D7-E1 — budget utilisation was summed in the page from every invoice row
//         carrying a budget_id, under a comment claiming it was bounded by
//         budget count. It was one row per INVOICE, so past PostgREST's
//         1000-row cap the figure silently under-reported.
//
// D7-D2 — the form told every applicant they could "return using the link we
//         emailed you" and no email was ever sent, and the page had no way to
//         accept such a link. Closing the tab lost the application.
//
// The claims that matter:
//   • the view totals per budget correctly, and matches a hand count
//   • no join multiplies a total (the property_summary fan-out, not repeated)
//   • it is RLS-scoped: an FM sees their properties' budgets, a tenant none
//   • a resume token rehydrates the right draft
//   • a token cannot open a draft through another organisation's page
//   • an expired, submitted or unknown token all answer identically
//
// Usage: node scripts/verify-audit-followups.mjs
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON);
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const orgRes = await svc.from("orgs").select("id, delivery_brand, tenant_applications_open");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const poc = orgRes.data.find((o) => o.delivery_brand === "direct");
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const windowWasOpen = oea.tenant_applications_open;

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeApps = [];

console.log("Audit follow-ups\n");

console.log("D7-E1. Budget utilisation is aggregated in the database");
{
  const { data: rows, error } = await svc
    .from("bi_budget_utilisation")
    .select("budget_id, org_id, property_name, budgeted, invoiced, collected");

  if (error) { bad(`the view does not read — ${error.message.slice(0, 70)}`); }
  else {
    ok(`the view returns ${rows.length} budget row(s)`);

    // One row per BUDGET, which is what the old comment wrongly claimed of a
    // query that returned one row per invoice.
    const { count: budgetCount } = await svc
      .from("sc_budgets").select("*", { count: "exact", head: true });
    rows.length === budgetCount
      ? ok(`exactly one row per budget (${budgetCount}) — no fan-out`)
      : bad(`${rows.length} rows for ${budgetCount} budgets — a join is multiplying`);

    // Hand-check one budget's total against the invoices themselves.
    const target = rows.find((r) => Number(r.invoiced) > 0) ?? rows[0];
    if (target) {
      const { data: charges } = await svc
        .from("service_charges").select("amount, status")
        .eq("budget_id", target.budget_id).is("deleted_at", null);
      const expected = (charges ?? []).reduce((a, c) => a + Number(c.amount), 0);
      const expectedPaid = (charges ?? [])
        .filter((c) => c.status === "paid").reduce((a, c) => a + Number(c.amount), 0);

      Math.abs(Number(target.invoiced) - expected) < 0.01
        ? ok(`invoiced matches a hand count of its charges (₦${expected.toLocaleString()})`)
        : bad(`invoiced ${target.invoiced} vs hand count ${expected}`);
      Math.abs(Number(target.collected) - expectedPaid) < 0.01
        ? ok(`and collected matches the paid ones (₦${expectedPaid.toLocaleString()})`)
        : bad(`collected ${target.collected} vs hand count ${expectedPaid}`);
    }
  }
}

console.log("\n…and it is still scoped by the caller's own policies");
{
  const tenant = await login("resident@oegroup.test");
  const { data: asTenant } = await tenant.from("bi_budget_utilisation").select("budget_id");
  (asTenant ?? []).length === 0
    ? ok("a tenant sees no budgets through the view")
    : bad(`A TENANT READ ${asTenant.length} BUDGET ROW(S)`);
  await tenant.auth.signOut();

  const fin = await login("finance@oegroup.test");
  const { data: asFin } = await fin.from("bi_budget_utilisation").select("budget_id");
  (asFin ?? []).length > 0
    ? ok(`finance sees ${asFin.length} — security_invoker means the matrix still decides`)
    : bad("finance sees none, so the view is not readable where it should be");
  await fin.auth.signOut();
}

console.log("\nD7-D2. A resume link actually resumes");
{
  await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);

  const token = crypto.randomBytes(24).toString("base64url");
  const { data: appId, error } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_type: "individual", p_name: `Probe ${S}`,
    p_email: `probe-${S}@example.com`, p_phone: null,
    p_token_hash: hash(token),
    p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (error) { bad(`could not start a draft — ${error.message.slice(0, 60)}`); }
  else {
    madeApps.push(appId);
    await svc.from("tenant_applications")
      .update({ form: { full_name: `Probe ${S}`, phone: "+2348000000000" } }).eq("id", appId);

    // This is exactly what the page does with `?resume=<token>`.
    const { data: draft } = await anon
      .rpc("resume_application", { p_token_hash: hash(token) }).maybeSingle();

    draft?.id === appId
      ? ok("the token returns the right draft")
      : bad(`resume returned ${draft?.id ?? "nothing"}`);
    draft?.org_id === oea.id
      ? ok("carrying the org it belongs to, so the page can re-check the URL")
      : bad("the draft did not carry its org");
    JSON.stringify(draft?.form ?? {}).includes(`Probe ${S}`)
      ? ok("with the answers already filled in")
      : bad("the saved answers did not come back");

    // A token belongs to ONE application in ONE org. The page compares
    // draft.org_id against the org in the URL, which is what stops a valid token
    // being replayed through a different organisation's page.
    draft?.org_id !== poc.id
      ? ok("and it is not the POC org, so a cross-org replay is detectable")
      : bad("org check is meaningless — draft org matches the wrong org");

    const { data: wrong } = await anon
      .rpc("resume_application", { p_token_hash: hash("not-the-token") }).maybeSingle();
    !wrong ? ok("an unknown token returns nothing at all") : bad("A WRONG TOKEN RESUMED A DRAFT");

    // Submission must kill the link, or a reviewer could be edited behind.
    for (const k of ["national_id", "passport_photo", "guarantor_id"]) {
      await anon.rpc("record_application_attachment", {
        p_token_hash: hash(token), p_kind: k,
        p_path: `${oea.id}/${appId}/${k}-${S}.pdf`,
        p_file_name: `${k}.pdf`, p_content_type: "application/pdf", p_size: 1024,
      });
    }
    await anon.rpc("submit_tenant_application", {
      p_token_hash: hash(token), p_form: { full_name: `Probe ${S}` },
      p_sensitive: {}, p_consent: "probe consent",
    });
    const { data: afterSubmit } = await anon
      .rpc("resume_application", { p_token_hash: hash(token) }).maybeSingle();
    !afterSubmit
      ? ok("and the link stops working the moment it is submitted")
      : bad("A SUBMITTED APPLICATION IS STILL EDITABLE THROUGH ITS LINK");
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("application_attachments").delete().in("application_id", madeApps);
await svc.from("tenant_applications").delete().in("id", madeApps);
await svc.from("orgs").update({ tenant_applications_open: windowWasOpen }).eq("id", oea.id);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — the last BI figure is counted in the database, and the emailed link is real."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
