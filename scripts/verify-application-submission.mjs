// An applicant must be able to submit — and only with their documents.
//
// The defect this guards (PC2 audit D7-D1, reproduced before fixing): the submit
// path checked required documents by reading `application_attachments` through the
// applicant's own session. There is no anon SELECT policy on that table, and a
// query with no matching policy returns ZERO ROWS WITHOUT ERRORING — so every
// uploaded document read as missing and submission was impossible.
//
// And the half the audit did not name: `submit_tenant_application` is granted to
// `anon`, so a check living in the server action could simply be posted past.
//
// The claims that matter:
//   • an applicant with all required documents can submit
//   • an applicant missing one cannot, and is told which
//   • the gate cannot be bypassed by calling the RPC directly
//   • the required list is per-org and per-type configuration, not a constant
//   • `sensitive` and `resume_token_hash` are unreadable by authenticated users
//
// Usage: node scripts/verify-application-submission.mjs
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
// An application is now raised against a PROPERTY (0076), so these checks need
// one that is accepting. Forced `open` rather than relying on a vacant unit: a
// suite should test what it is about, not the occupancy of demo data.
async function probeProperty(svcClient, orgId, label) {
  const { data, error } = await svcClient.from("properties")
    .insert({ org_id: orgId, name: `PROBE-PROP-${label}` })
    .select("id").single();
  if (error) throw new Error(`could not create a probe property: ${error.message}`);
  await svcClient.rpc("set_property_application_state", {
    p_property_id: data.id, p_state: "open", p_note: "verification fixture",
  });
  return data.id;
}


const orgRes = await svc.from("orgs").select("id, delivery_brand, tenant_applications_open");
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");
const windowWasOpen = oea.tenant_applications_open;

const S = Date.now().toString(36).toUpperCase().slice(-5);
const made = [];
const probeProps = [];

await svc.from("orgs").update({ tenant_applications_open: true }).eq("id", oea.id);
probeProps.push(await probeProperty(svc, oea.id, `S-${S}`));

async function startDraft(type = "individual") {
  const token = crypto.randomBytes(24).toString("base64url");
  const { data: id, error } = await anon.rpc("start_tenant_application", {
    p_org_id: oea.id, p_property_id: probeProps[0], p_type: type, p_name: `Probe ${S}`,
    p_email: `probe-${S}-${made.length}@example.com`, p_phone: null,
    p_token_hash: hash(token), p_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (error) throw new Error(error.message);
  made.push(id);
  return { id, token };
}
const upload = (id, token, kind) =>
  anon.rpc("record_application_attachment", {
    p_token_hash: hash(token), p_kind: kind,
    p_path: `${oea.id}/${id}/${kind}-${S}.pdf`,
    p_file_name: `${kind}.pdf`, p_content_type: "application/pdf", p_size: 2048,
  });
const submit = (token) =>
  anon.rpc("submit_tenant_application", {
    p_token_hash: hash(token), p_form: { full_name: `Probe ${S}` },
    p_sensitive: {}, p_consent: "probe consent",
  });

console.log("Tenancy application submission\n");

console.log("A. The requirements are configuration, and an applicant can read them");
{
  const { data: reqs } = await anon
    .from("application_document_requirements")
    .select("kind, label, required").eq("org_id", oea.id).eq("type", "individual");
  (reqs ?? []).length === 3
    ? ok(`three documents required of an individual (${(reqs ?? []).map((r) => r.kind).join(", ")})`)
    : bad(`found ${(reqs ?? []).length} requirement(s), expected 3`);

  const { data: corp } = await anon
    .from("application_document_requirements")
    .select("kind").eq("org_id", oea.id).eq("type", "corporate");
  (corp ?? []).length === 3
    ? ok("and three of a business, with a different set")
    : bad(`corporate had ${(corp ?? []).length}`);
}

console.log("\nB. Missing a document — refused, and named");
{
  const { id, token } = await startDraft();
  await upload(id, token, "national_id");
  await upload(id, token, "passport_photo");
  // guarantor_id deliberately absent.

  const { data: status } = await anon.rpc("application_document_status", { p_token_hash: hash(token) });
  const outstanding = (status ?? []).filter((r) => r.required && !r.uploaded);
  outstanding.length === 1 && outstanding[0].kind === "guarantor_id"
    ? ok("the applicant is told exactly what is outstanding, under their own token")
    : bad(`status reported ${outstanding.length} outstanding`);

  const { error } = await submit(token);
  error?.message?.includes("Still to upload")
    ? ok(`submission refused: "${error.message.slice(0, 58)}…"`)
    : bad(`submission was NOT refused (error: ${error?.message ?? "none"})`);
}

console.log("\nC. All documents present — submission succeeds");
{
  const { id, token } = await startDraft();
  for (const k of ["national_id", "passport_photo", "guarantor_id"]) await upload(id, token, k);

  const { data: submitted, error } = await submit(token);
  if (error) bad(`SUBMISSION STILL BLOCKED — ${error.message.slice(0, 80)}`);
  else {
    submitted === id ? ok("the application submitted") : bad("submit returned the wrong id");
    const { data: row } = await svc.from("tenant_applications")
      .select("status, submitted_at, consent_given_at, resume_token_hash").eq("id", id).single();
    row.status === "submitted" && row.submitted_at
      ? ok("its status and timestamp are recorded")
      : bad(`status is ${row.status}`);
    row.resume_token_hash === null
      ? ok("and the draft link died at submission")
      : bad("THE RESUME TOKEN SURVIVED SUBMISSION");
  }
}

console.log("\nD. The gate cannot be bypassed by calling the function directly");
{
  // This IS the direct call — the server action is not involved anywhere in this
  // suite. B already proved a short application is refused at the RPC, so the
  // remaining question is whether the requirement can be dodged by type.
  const { id, token } = await startDraft("corporate");
  await upload(id, token, "cac");
  await upload(id, token, "tin");
  // The corporate set also needs the authorised contact's ID.
  const { error } = await submit(token);
  error?.message?.includes("Still to upload")
    ? ok("a business submission is held to the corporate list, not the individual one")
    : bad(`corporate gate did not hold (error: ${error?.message ?? "none"})`);

  await upload(id, token, "national_id");
  const { error: e2 } = await submit(token);
  !e2 ? ok("and passes once that document is there") : bad(`still blocked — ${e2.message.slice(0, 60)}`);
}

console.log("\nE. Turning a requirement off changes what is enforced");
{
  await svc.from("application_document_requirements")
    .update({ required: false })
    .eq("org_id", oea.id).eq("type", "individual").eq("kind", "guarantor_id");

  const { id, token } = await startDraft();
  await upload(id, token, "national_id");
  await upload(id, token, "passport_photo");
  const { error } = await submit(token);
  !error
    ? ok("with the guarantor ID made optional, the same application submits")
    : bad(`still refused — ${error.message.slice(0, 60)}`);

  await svc.from("application_document_requirements")
    .update({ required: true })
    .eq("org_id", oea.id).eq("type", "individual").eq("kind", "guarantor_id");
}

console.log("\nF. Two columns an authenticated user must not read");
{
  const c = createClient(URL_, ANON);
  const { error: le } = await c.auth.signInWithPassword({ email: "oea@oegroup.test", password: PW });
  if (le) bad(`could not sign in as the OEA administrator — ${le.message}`);
  else {
    const sens = await c.from("tenant_applications").select("sensitive").limit(1);
    sens.error
      ? ok("special-category data is refused at the privilege level, not merely hidden by a view")
      : bad("A REVIEWER READ THE `sensitive` COLUMN FROM THE BASE TABLE");

    const tok = await c.from("tenant_applications").select("resume_token_hash").limit(1);
    tok.error
      ? ok("and the resume token hash is unreadable — holding it means holding the applicant's link")
      : bad("A REVIEWER READ `resume_token_hash` — they could resume and submit someone's application");

    const fine = await c.from("tenant_applications").select("id, status, applicant_name").limit(1);
    !fine.error
      ? ok("everything a reviewer legitimately needs still reads")
      : bad(`the revoke went too far — ${fine.error.message.slice(0, 60)}`);

    const view = await c.from("application_overview").select("id, applicant_name").limit(1);
    !view.error
      ? ok("and application_overview is unaffected")
      : bad(`the reviewer's view broke — ${view.error.message.slice(0, 60)}`);
    await c.auth.signOut();
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("application_attachments").delete().in("application_id", made);
await svc.from("tenant_applications").delete().in("id", made);
await svc.from("properties").delete().in("id", probeProps);
await svc.from("orgs").update({ tenant_applications_open: windowWasOpen }).eq("id", oea.id);
console.log(`\n(cleaned up; OEA's window returned to ${windowWasOpen ? "open" : "closed"})`);

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — an applicant can submit, only with their documents, and the gate is inside the transition."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
