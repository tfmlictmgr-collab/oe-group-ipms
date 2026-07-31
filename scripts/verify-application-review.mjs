// Day 8 — two-tier human review, and only human review.
//
// Locked decisions 2 and 10: a PM/FM recommends, an approver decides
// independently, never automated. Individual needs one approver; corporate needs
// two DISTINCT approvers. The recommender may never also approve.
//
// The claims that matter:
//   • recommend is refused to a non-holder and to someone outside their scope
//   • a reason under 10 characters is refused, with a clear message
//   • the recommender can never also approve or reject (maker-checker)
//   • approval is refused with no unit assigned
//   • individual: one approval completes it and issues a tenant invitation
//   • corporate: the first of two approvals is recorded and decides nothing;
//     the SAME person cannot approve twice; a second distinct approver completes it
//   • the completing invitation, once accepted, makes the applicant a tenant
//     occupying exactly the assigned unit — and the unit is then no longer vacant
//   • rejection sets a 90-day purge date; approval does not touch it
//   • an info request mints a fresh token and the applicant can resubmit;
//     resubmission clears a stale recommendation
//   • the queue (application_overview) reports progress without a join, and
//     stays scoped by the caller's own property reach
//
// Usage: node scripts/verify-application-review.mjs
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
const hash = (t) => crypto.createHash("sha256").update(t.trim()).digest("hex");
async function login(email) {
  const c = createClient(URL_, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const orgRes = await svc.from("orgs").select("id, delivery_brand").is("deleted_at", null);
if (orgRes.error) { console.error("db unreachable:", orgRes.error.message); process.exit(1); }
const oea = orgRes.data.find((o) => o.delivery_brand === "OEA");

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeProps = [];
const madeUnits = [];
const madeApps = [];

// Sweep debris from an earlier crashed run.
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probereview.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
}

async function makeUser(role, tag) {
  const email = `probereview.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({ id: created.user.id, org_id: oea.id, email, full_name: `Probe ${tag}`, role });
  madeUsers.push(created.user.id);
  return { id: created.user.id, email };
}

const mkProperty = async (name) => {
  const { data, error } = await svc.from("properties").insert({ org_id: oea.id, name }).select("id").single();
  if (error) throw new Error(error.message);
  madeProps.push(data.id);
  return data.id;
};
const mkUnit = async (propertyId, label) => {
  const { data, error } = await svc.from("units")
    .insert({ org_id: oea.id, property_id: propertyId, label, apportionment_factor: 1 })
    .select("id").single();
  if (error) throw new Error(error.message);
  madeUnits.push(data.id);
  return data.id;
};
const mkApp = async (propertyId, type, tag) => {
  const { data, error } = await svc.from("tenant_applications").insert({
    org_id: oea.id, property_id: propertyId, type, status: "submitted",
    applicant_name: `Probe Applicant ${tag}`, applicant_email: `probeapp-${tag}-${S}@example.com`,
    consent_given_at: new Date().toISOString(), consent_statement: "probe consent",
  }).select("id").single();
  if (error) throw new Error(error.message);
  madeApps.push(data.id);
  return data.id;
};

console.log("Day 8 — two-tier review\n");

const propA = await mkProperty(`PROBEREV-A-${S}`);
const unit1 = await mkUnit(propA, `1-${S}`);
const unit2 = await mkUnit(propA, `2-${S}`);

const fm1 = await makeUser("facility_manager", "fm1");
const fm2 = await makeUser("facility_manager", "fm2"); // deliberately NOT attached to propA
await svc.from("property_stakeholders").insert({ org_id: oea.id, user_id: fm1.id, property_id: propA, relation: "manager" });

const { data: adminUser } = await svc.from("users").select("id, email").eq("email", "oea@oegroup.test").single();
const { data: financeUser } = await svc.from("users").select("id, email").eq("email", "finance.oea@oegroup.test").single();

console.log("A. Recommend — held capability and property scope");
const indApp = await mkApp(propA, "individual", "ind");
{
  const c2 = await login(fm2.email);
  const { error } = await c2.rpc("record_application_recommendation", {
    p_application_id: indApp, p_approve: true, p_reason: "looks fine to me, references check out",
  });
  error ? ok("a facility manager outside the property is refused") : bad("FM2 RECOMMENDED OUTSIDE THEIR SCOPE");
  await c2.auth.signOut();

  const c1 = await login(fm1.email);
  const { error: shortReason } = await c1.rpc("record_application_recommendation", {
    p_application_id: indApp, p_approve: true, p_reason: "ok",
  });
  shortReason ? ok("a reason under 10 characters is refused") : bad("A ONE-WORD REASON WAS ACCEPTED");

  const { error: recErr } = await c1.rpc("record_application_recommendation", {
    p_application_id: indApp, p_approve: true, p_reason: "documents check out, steady income, good references",
  });
  !recErr ? ok("the attached facility manager may recommend") : bad(`recommend failed — ${recErr.message.slice(0, 70)}`);
  await c1.auth.signOut();

  const { data: after } = await svc.from("tenant_applications")
    .select("status, recommendation, recommended_by").eq("id", indApp).single();
  after.status === "under_review" && after.recommendation === "approve" && after.recommended_by === fm1.id
    ? ok("recorded: under_review, recommendation=approve, attributed to the recommender")
    : bad(`status=${after.status} rec=${after.recommendation} by=${after.recommended_by}`);
}

console.log("\nB. Maker-checker — the recommender can never also decide");
{
  const c1 = await login(fm1.email);
  const { error } = await c1.rpc("record_application_approval", {
    p_application_id: indApp, p_reason: "I already reviewed this myself, approving it too",
  });
  error ? ok("the recommender is refused when trying to approve their own recommendation")
        : bad("THE RECOMMENDER APPROVED THEIR OWN RECOMMENDATION");
  await c1.auth.signOut();
}

console.log("\nC. Approval refuses with no unit assigned");
{
  const admin = await login(adminUser.email);
  const { error } = await admin.rpc("record_application_approval", {
    p_application_id: indApp, p_reason: "documents verified independently, approving",
    p_invite_token_hash: hash("unused"),
  });
  error && /unit/i.test(error.message)
    ? ok("refused with no unit assigned, and says so")
    : bad(`expected a unit-related refusal, got: ${error?.message ?? "no error"}`);
  await admin.auth.signOut();
}

console.log("\nD. Assigning the unit is scoped the same way");
{
  const c2 = await login(fm2.email);
  const { error } = await c2.rpc("assign_application_unit", { p_application_id: indApp, p_unit_id: unit1 });
  error ? ok("an unattached facility manager cannot assign a unit") : bad("FM2 ASSIGNED A UNIT OUTSIDE THEIR SCOPE");
  await c2.auth.signOut();

  const c1 = await login(fm1.email);
  const { error: ok1 } = await c1.rpc("assign_application_unit", { p_application_id: indApp, p_unit_id: unit1 });
  !ok1 ? ok("the attached facility manager assigns it") : bad(`assignment failed — ${ok1.message.slice(0, 70)}`);
  await c1.auth.signOut();
}

console.log("\nE. Individual: one approval completes it and issues a tenant invitation");
let indInviteToken, indInviteId;
{
  indInviteToken = crypto.randomBytes(24).toString("base64url");
  const admin = await login(adminUser.email);
  const { data: inviteId, error } = await admin.rpc("record_application_approval", {
    p_application_id: indApp, p_reason: "independently verified — income, ID and guarantor all check out",
    p_invite_token_hash: hash(indInviteToken),
  });
  !error && inviteId ? ok("approved, and an invitation id was returned") : bad(`approval failed — ${error?.message.slice(0, 70)}`);
  indInviteId = inviteId;
  await admin.auth.signOut();

  const { data: after } = await svc.from("tenant_applications")
    .select("status, decided_by, decided_at, decision_notes, purge_after").eq("id", indApp).single();
  after.status === "approved" && after.decided_by === adminUser.id
    ? ok("status is approved, attributed to the approver")
    : bad(`status=${after.status} decided_by=${after.decided_by}`);
  after.purge_after === null
    ? ok("no purge date set on approval — retention runs from tenancy end, not this")
    : bad(`purge_after was set on an approval: ${after.purge_after}`);

  const { data: inv } = await svc.from("invitations")
    .select("role, unit_id, email").eq("id", indInviteId).single();
  inv.role === "tenant" && inv.unit_id === unit1
    ? ok("the invitation carries role=tenant and the assigned unit")
    : bad(`invitation role=${inv.role} unit=${inv.unit_id}`);
}

console.log("\nF. The invitation, accepted, makes them a tenant occupying the unit");
{
  const email = `probereview.newtenant.${S}@example.com`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) { bad(`could not create the applicant's account — ${error.message}`); }
  else {
    madeUsers.push(created.user.id);
    // Their email must match the invitation's — set it to the applicant's, since
    // accept_invitation checks auth.users.email against invitations.email.
    await svc.auth.admin.updateUserById(created.user.id, { email: `probeapp-ind-${S}@example.com`, email_confirm: true });

    const c = createClient(URL_, ANON);
    await c.auth.signInWithPassword({ email: `probeapp-ind-${S}@example.com`, password: PW });
    const { error: acceptErr } = await c.rpc("accept_invitation", { p_token_hash: hash(indInviteToken) });
    !acceptErr ? ok("the invitation accepts") : bad(`accept failed — ${acceptErr.message.slice(0, 70)}`);

    const { data: newUser } = await svc.from("users").select("role, org_id").eq("id", created.user.id).single();
    newUser?.role === "tenant" && newUser?.org_id === oea.id
      ? ok("they are now a tenant of OEA")
      : bad(`role=${newUser?.role} org=${newUser?.org_id}`);

    const { data: u } = await svc.from("units").select("occupant_user_id").eq("id", unit1).single();
    u.occupant_user_id === created.user.id
      ? ok("and the occupant of exactly the unit assigned during review")
      : bad(`unit occupant is ${u.occupant_user_id}, expected ${created.user.id}`);
    await c.auth.signOut();
  }
}

console.log("\nG. The unit, now occupied, cannot be assigned to another application");
{
  const other = await mkApp(propA, "individual", "other");
  const c1 = await login(fm1.email);
  const { error } = await c1.rpc("assign_application_unit", { p_application_id: other, p_unit_id: unit1 });
  error && /occupant/i.test(error.message)
    ? ok("refused — that unit already has an occupant")
    : bad(`expected an occupant refusal, got: ${error?.message ?? "none"}`);
  await c1.auth.signOut();
}

console.log("\nH. Corporate — two DISTINCT approvers, never one twice");
const corpApp = await mkApp(propA, "corporate", "corp");
{
  const c1 = await login(fm1.email);
  await c1.rpc("record_application_recommendation", {
    p_application_id: corpApp, p_approve: true, p_reason: "CAC verified, TIN matches, trade references good",
  });
  await c1.rpc("assign_application_unit", { p_application_id: corpApp, p_unit_id: unit2 });
  await c1.auth.signOut();

  const admin = await login(adminUser.email);
  const tok1 = crypto.randomBytes(24).toString("base64url");
  const { data: firstResult, error: e1 } = await admin.rpc("record_application_approval", {
    p_application_id: corpApp, p_reason: "verified independently, this is the first of two approvals",
    p_invite_token_hash: hash(tok1),
  });
  !e1 ? ok("the first of two approvals is accepted") : bad(`first approval failed — ${e1.message.slice(0, 70)}`);
  firstResult === null
    ? ok("and returns null — it decides nothing on its own")
    : bad(`the first corporate approval returned ${firstResult}, expected null`);

  const { data: mid } = await svc.from("tenant_applications").select("status").eq("id", corpApp).single();
  mid.status === "under_review"
    ? ok("the application stays under_review after one of two")
    : bad(`status is already ${mid.status} after only one approval`);

  const { error: dupErr } = await admin.rpc("record_application_approval", {
    p_application_id: corpApp, p_reason: "approving again with the same account to see what happens",
    p_invite_token_hash: hash("dup"),
  });
  dupErr ? ok("the SAME approver cannot approve a second time")
         : bad("ONE PERSON APPROVED A CORPORATE APPLICATION TWICE");
  await admin.auth.signOut();

  const fin = await login(financeUser.email);
  const tok2 = crypto.randomBytes(24).toString("base64url");
  const { data: secondResult, error: e2 } = await fin.rpc("record_application_approval", {
    p_application_id: corpApp, p_reason: "independently verified, second and completing approval",
    p_invite_token_hash: hash(tok2),
  });
  !e2 && secondResult ? ok("a DISTINCT second approver completes it, and an invitation id is returned")
                      : bad(`second approval failed — ${e2?.message.slice(0, 70)}`);
  await fin.auth.signOut();

  const { data: done } = await svc.from("tenant_applications").select("status").eq("id", corpApp).single();
  done.status === "approved" ? ok("status is now approved") : bad(`status is ${done.status}`);

  const { data: approvals } = await svc.from("application_decisions")
    .select("decided_by").eq("application_id", corpApp).eq("kind", "approve");
  new Set((approvals ?? []).map((a) => a.decided_by)).size === 2
    ? ok("exactly two distinct approvers are on the record")
    : bad(`${(approvals ?? []).length} approval row(s), ${new Set((approvals ?? []).map((a) => a.decided_by)).size} distinct`);
}

console.log("\nI. Rejection — a 90-day purge date, and the recommender still cannot decide");
const rejApp = await mkApp(propA, "individual", "rej");
{
  const c1 = await login(fm1.email);
  await c1.rpc("record_application_recommendation", {
    p_application_id: rejApp, p_approve: true, p_reason: "seemed fine on the surface, referring up",
  });
  const { error: selfReject } = await c1.rpc("record_application_rejection", {
    p_application_id: rejApp, p_reason: "changed my mind, rejecting my own recommendation",
  });
  selfReject ? ok("the recommender is refused when trying to reject their own recommendation too")
             : bad("THE RECOMMENDER REJECTED THEIR OWN RECOMMENDATION");
  await c1.auth.signOut();

  const admin = await login(adminUser.email);
  const { error } = await admin.rpc("record_application_rejection", {
    p_application_id: rejApp, p_reason: "income verification failed independently on our side",
  });
  !error ? ok("an independent approver rejects it") : bad(`rejection failed — ${error.message.slice(0, 70)}`);
  await admin.auth.signOut();

  const { data: after } = await svc.from("tenant_applications")
    .select("status, purge_after").eq("id", rejApp).single();
  after.status === "rejected" ? ok("status is rejected") : bad(`status is ${after.status}`);
  if (after.purge_after) {
    const days = (new Date(after.purge_after) - Date.now()) / 86_400_000;
    days > 89 && days < 91
      ? ok(`purge_after is ~90 days out (${days.toFixed(1)}), per the retention rule`)
      : bad(`purge_after is ${days.toFixed(1)} days out`);
  } else {
    bad("no purge_after was set on rejection");
  }
}

console.log("\nJ. Information requested — a fresh link, and resubmission clears the stale recommendation");
const infoApp = await mkApp(propA, "individual", "info");
{
  const c1 = await login(fm1.email);
  const newToken = crypto.randomBytes(24).toString("base64url");
  const { error } = await c1.rpc("record_application_info_request", {
    p_application_id: infoApp, p_reason: "please upload a clearer copy of the guarantor's ID",
    p_token_hash: hash(newToken), p_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  !error ? ok("the request is recorded") : bad(`request failed — ${error.message.slice(0, 70)}`);
  await c1.auth.signOut();

  const { data: after } = await svc.from("tenant_applications")
    .select("status, resume_token_hash").eq("id", infoApp).single();
  after.status === "info_requested" && after.resume_token_hash === hash(newToken)
    ? ok("status is info_requested and a fresh token is stored")
    : bad(`status=${after.status}`);

  // Force a recommendation onto it as if tier 1 had already acted (to prove
  // resubmission clears it), then resubmit through the new token.
  await svc.from("tenant_applications")
    .update({ recommendation: "approve", recommended_by: fm1.id, recommended_at: new Date().toISOString() })
    .eq("id", infoApp);

  const anon = createClient(URL_, ANON);

  // The Day 7 document-completeness gate applies to a resubmission exactly as it
  // does to the first one — proven here rather than assumed, by attaching the
  // three required documents under the NEW token before resubmitting.
  for (const kind of ["national_id", "passport_photo", "guarantor_id"]) {
    await anon.rpc("record_application_attachment", {
      p_token_hash: hash(newToken), p_kind: kind,
      p_path: `${oea.id}/${infoApp}/${kind}-${S}.pdf`,
      p_file_name: `${kind}.pdf`, p_content_type: "application/pdf", p_size: 1024,
    });
  }
  const { data: resub, error: subErr } = await anon.rpc("submit_tenant_application", {
    p_token_hash: hash(newToken), p_form: { note: "clearer ID uploaded" },
    p_sensitive: {}, p_consent: "probe consent v2",
  });
  !subErr && resub === infoApp ? ok("the applicant resubmits through the new link")
                                : bad(`resubmit failed — ${subErr?.message.slice(0, 70)}`);

  const { data: post } = await svc.from("tenant_applications")
    .select("status, recommendation, recommended_by, resume_token_hash").eq("id", infoApp).single();
  post.status === "submitted" ? ok("back to submitted — tier 1 runs again") : bad(`status is ${post.status}`);
  post.recommendation === null && post.recommended_by === null
    ? ok("the stale recommendation was cleared, not carried forward")
    : bad("A STALE RECOMMENDATION SURVIVED A RESUBMISSION");
  post.resume_token_hash === null
    ? ok("and the link dies again the moment it is used")
    : bad("the resume link survived resubmission");
}

console.log("\nK. The queue reports progress without a join, and stays scoped");
{
  const c1 = await login(fm1.email);
  const { data: seen } = await c1.from("application_overview")
    .select("id, approvals_count, approvals_needed").in("id", [indApp, corpApp]);
  const byId = Object.fromEntries((seen ?? []).map((r) => [r.id, r]));
  byId[indApp]?.approvals_count === 1 && byId[indApp]?.approvals_needed === 1
    ? ok("individual application: 1 of 1 approvals shown")
    : bad(`individual: ${byId[indApp]?.approvals_count}/${byId[indApp]?.approvals_needed}`);
  byId[corpApp]?.approvals_count === 2 && byId[corpApp]?.approvals_needed === 2
    ? ok("corporate application: 2 of 2 approvals shown")
    : bad(`corporate: ${byId[corpApp]?.approvals_count}/${byId[corpApp]?.approvals_needed}`);
  await c1.auth.signOut();

  const c2 = await login(fm2.email);
  const { data: outside } = await c2.from("application_overview").select("id").in("id", madeApps);
  (outside ?? []).length === 0
    ? ok("a facility manager outside the property sees none of this property's applications")
    : bad(`FM2 SAW ${outside.length} APPLICATION(S) OUTSIDE THEIR SCOPE`);
  await c2.auth.signOut();
}

// ── Cleanup ────────────────────────────────────────────────────────────────
await svc.from("invitations").delete().in("application_id", []).is("id", null); // no-op guard
await svc.from("invitations").delete().eq("org_id", oea.id).like("email", "probeapp-%");
await svc.from("application_decisions").delete().in("application_id", madeApps);
await svc.from("application_attachments").delete().in("application_id", madeApps);
await svc.from("tenant_applications").delete().in("id", madeApps);
await svc.from("property_stakeholders").delete().in("user_id", madeUsers);
await svc.from("units").update({ occupant_user_id: null }).in("id", madeUnits);
await svc.from("units").delete().in("id", madeUnits);
await svc.from("properties").delete().in("id", madeProps);
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a PM recommends, an approver decides independently, and nothing decides itself."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
