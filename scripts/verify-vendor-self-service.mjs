// Vendor self-service: sub-users, the registration pack, and cross-brand
// introduction (0163 / 0164 / 0165).
//
// ⚠️ What this suite is really for. Section A is a regression test for a live
// defect, not a feature check: `accept_invitation` used to end with
// `update vendors set user_id = v_uid`, so inviting a SECOND person to a vendor
// silently EVICTED the first — the original login kept a `role = 'vendor'`
// account attached to no vendor at all, which is the exact broken state 0116
// was written to prevent, reached from the other direction. If A3 ever fails
// again, somebody has reintroduced it.
//
// Section E is the one that matters for B1. The receiving organisation must
// learn that a contractor has a registration elsewhere WITHOUT learning where —
// so E4 asserts on the shape of what crosses, not on a policy or a grant table.
//
// Verified by ATTEMPTING each refused operation as a real signed-in user, never
// by reading a policy or a grant table — reading grants is what produced the
// "68 tables writable by anon" false alarm on this project.
//
// Usage: node scripts/verify-vendor-self-service.mjs
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PW = "ProbeVendorPassw0rd!";

if (!URL_ || !ANON || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / ANON KEY / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (/prod/i.test(URL_)) {
  console.error("Refusing to run: target looks like production. This writes fixture rows.");
  process.exit(2);
}

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const eq = (m, actual, expected) =>
  String(actual) === String(expected) ? ok(m) : bad(`${m} — expected ${expected}, got ${actual}`);
const refused = (m, error) =>
  error ? ok(`${m} — refused: ${error.message.slice(0, 64)}`) : bad(`${m} — WAS ALLOWED`);

const svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const hash = (t) => crypto.createHash("sha256").update(t.trim()).digest("hex");

async function login(email) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const S = Date.now().toString(36).toUpperCase().slice(-5);
const madeUsers = [];
const madeVendors = [];

// Start-of-run sweep — end-of-run cleanup cannot repair end-of-run cleanup.
{
  const { data: stale } = await svc.from("users").select("id").like("email", "probevss.%@oegroup.test");
  for (const u of stale ?? []) {
    await svc.from("vendor_users").delete().eq("user_id", u.id);
    await svc.from("invitations").delete().eq("invited_by", u.id);
    await svc.from("users").delete().eq("id", u.id);
    await svc.auth.admin.deleteUser(u.id).catch(() => {});
  }
  const { data: staleV } = await svc.from("vendors").select("id").like("name", "Probe VSS%");
  for (const v of staleV ?? []) {
    await svc.from("vendor_introductions").delete().eq("source_vendor_id", v.id);
    await svc.from("vendor_documents").delete().eq("vendor_id", v.id);
    await svc.from("vendor_registrations").delete().eq("vendor_id", v.id);
    await svc.from("vendor_users").delete().eq("vendor_id", v.id);
    await svc.from("tickets").delete().eq("assigned_vendor_id", v.id);
    await svc.from("payments").delete().eq("vendor_id", v.id);
    await svc.from("vendors").delete().eq("id", v.id);
  }
}

const { data: orgs, error: orgErr } = await svc
  .from("orgs").select("id, slug, name").is("deleted_at", null).not("slug", "is", null);
if (orgErr) { console.error("db unreachable:", orgErr.message); process.exit(1); }
const org = orgs.find((o) => o.slug === "tfml") ?? orgs[0];
const otherOrg = orgs.find((o) => o.id !== org.id);
if (!org || !otherOrg) { console.error("Need two live slugged orgs to run this."); process.exit(2); }

async function makeUser(orgId, role, tag) {
  const email = `probevss.${tag}.${S}@oegroup.test`;
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  await svc.from("users").upsert({
    id: created.user.id, org_id: orgId, email, full_name: `Probe ${tag}`, role,
  });
  madeUsers.push(created.user.id);
  return { id: created.user.id, email, role };
}

async function makeVendor(orgId, label) {
  const { data, error } = await svc.from("vendors")
    .insert({ org_id: orgId, name: `Probe VSS ${label} ${S}`, service_category: "cleaning" })
    .select("id").single();
  if (error) throw new Error(`vendor ${label}: ${error.message}`);
  madeVendors.push(data.id);
  return data.id;
}

/** Issue a vendor invitation as `inviter`, returning the raw token. */
async function inviteVendorUser(inviterClient, orgId, vendorId, email, capabilities, inviterId) {
  const token = crypto.randomUUID();
  const { error } = await inviterClient.from("invitations").insert({
    org_id: orgId, email, role: "vendor", vendor_id: vendorId,
    vendor_capabilities: capabilities, token_hash: hash(token), invited_by: inviterId,
  });
  return { token, error };
}

/** Create an auth account on `email` and redeem `token` as them. */
async function redeem(email, token) {
  const { data: created, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`${email}: ${error.message}`);
  madeUsers.push(created.user.id);
  const c = await login(email);
  const { error: acceptErr } = await c.rpc("accept_invitation", { p_token_hash: hash(token) });
  return { client: c, id: created.user.id, error: acceptErr };
}

const admin = await makeUser(org.id, "admin", "admin");
const adminC = await login(admin.email);

console.log(`\nVendor self-service (0163/0164/0165) — org "${org.name}"\n`);

// ---------------------------------------------------------------------------
console.log("A. A vendor company can hold more than one login");
// ---------------------------------------------------------------------------
const vendorA = await makeVendor(org.id, "Alpha");
let ownerC, ownerId, workerC, workerId, readerC, readerId;

{
  const email = `probevss.owner.${S}@oegroup.test`;
  const { token, error } = await inviteVendorUser(adminC, org.id, vendorA, email, ["manage_users"], admin.id);
  if (error) { bad(`admin could not invite the first vendor login — ${error.message}`); }
  else {
    const r = await redeem(email, token);
    ownerC = r.client; ownerId = r.id;
    !r.error ? ok("the first invitation accepts") : bad(`first accept failed — ${r.error.message}`);

    const { data: m } = await svc.from("vendor_users")
      .select("is_owner, capabilities").eq("user_id", ownerId).maybeSingle();
    eq("A1 the company's first login becomes its owner", m?.is_owner, true);
    eq("A2 and holds every capability", (m?.capabilities ?? []).length, 4);
  }
}

{
  // THE REGRESSION. A second invitation must ADD, not evict.
  const email = `probevss.worker.${S}@oegroup.test`;
  const { token, error } = await inviteVendorUser(ownerC, org.id, vendorA, email, ["manage_work"], ownerId);
  if (error) { bad(`a manage_users vendor could not invite a colleague — ${error.message}`); }
  else {
    const r = await redeem(email, token);
    workerC = r.client; workerId = r.id;
    !r.error ? ok("the colleague's invitation accepts") : bad(`second accept failed — ${r.error.message}`);

    const { data: v } = await svc.from("vendors").select("user_id").eq("id", vendorA).single();
    v?.user_id === ownerId
      ? ok("A3 the original login still holds the company (0163's regression)")
      : bad(`A3 THE SECOND INVITE EVICTED THE FIRST — vendors.user_id is now ${v?.user_id}`);

    const { count } = await svc.from("vendor_users")
      .select("id", { count: "exact", head: true }).eq("vendor_id", vendorA);
    eq("A4 the company now has two logins", count, 2);
  }
}

{
  const email = `probevss.reader.${S}@oegroup.test`;
  const { token } = await inviteVendorUser(ownerC, org.id, vendorA, email, ["manage_contracts"], ownerId);
  const r = await redeem(email, token);
  readerC = r.client; readerId = r.id;
  !r.error ? ok("a contracts-only colleague joins") : bad(`third accept failed — ${r.error?.message}`);
}

// ---------------------------------------------------------------------------
console.log("\nB. A capability is what decides, not merely being a vendor");
// ---------------------------------------------------------------------------
{
  const { data: t, error: tErr } = await svc.from("tickets").insert({
    org_id: org.id, assigned_vendor_id: vendorA, status: "in_progress",
    assigned_at: new Date().toISOString(),
    message_text: `Probe VSS job ${S}`, category: "maintenance", channel: "portal",
  }).select("id").single();
  if (tErr) { bad(`ticket fixture — ${tErr.message}`); }
  else {
    const { data: seenByWorker } = await workerC.from("tickets").select("id").eq("id", t.id);
    eq("B1 a colleague sees the company's job (the resolver, not vendors.user_id)",
       seenByWorker?.length, 1);

    const { data: seenByReader } = await readerC.from("tickets").select("id").eq("id", t.id);
    eq("B2 so does the contracts-only colleague — reading is company-wide",
       seenByReader?.length, 1);

    const { error: readerComplete } = await readerC.rpc("complete_work_order", { p_ticket_id: t.id });
    refused("B3 but they cannot mark it complete without manage_work", readerComplete);

    const { error: workerComplete } = await workerC.rpc("complete_work_order", { p_ticket_id: t.id });
    !workerComplete ? ok("B4 the manage_work colleague can") : bad(`B4 refused — ${workerComplete.message}`);

    const { error: readerInvoice } = await readerC.rpc("submit_vendor_invoice", {
      p_amount: 50000, p_invoice_reference: `PROBE-${S}-R`, p_ticket_id: t.id,
    });
    refused("B5 and cannot raise an invoice against it", readerInvoice);

    const { error: workerInvoice } = await workerC.rpc("submit_vendor_invoice", {
      p_amount: 50000, p_invoice_reference: `PROBE-${S}-W`, p_ticket_id: t.id,
    });
    !workerInvoice ? ok("B6 the manage_work colleague can") : bad(`B6 refused — ${workerInvoice.message}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nC. The membership itself is not self-service");
// ---------------------------------------------------------------------------
{
  const { error } = await workerC.from("vendor_users").insert({
    org_id: org.id, vendor_id: vendorA, user_id: workerId, capabilities: ["manage_users"],
  });
  refused("C1 a vendor cannot mint a membership row directly", error);

  // ⚠️ Assert on the EFFECT, not on an error. A PostgREST update whose USING
  // clause matches no row succeeds with zero rows changed — checking only for
  // an error would have called that a failure here, and (worse) would call a
  // genuinely permitted escalation a pass somewhere else.
  await workerC.from("vendor_users").update({ is_owner: true }).eq("user_id", workerId);
  await workerC.from("vendor_users")
    .update({ capabilities: ["manage_users", "manage_work"] }).eq("user_id", workerId);
  {
    const { data: after } = await svc.from("vendor_users")
      .select("is_owner, capabilities").eq("user_id", workerId).single();
    after?.is_owner === false
      ? ok("C2 a manage_work colleague cannot promote themselves to owner")
      : bad("C2 A COLLEAGUE PROMOTED THEMSELVES TO OWNER");
    (after?.capabilities ?? []).includes("manage_users")
      ? bad("C3 A COLLEAGUE GRANTED THEMSELVES manage_users")
      : ok("C3 nor grant themselves manage_users");
  }

  // The escalation that the trigger, not the policy, has to stop: the owner
  // DOES hold manage_users, so the row is theirs to edit — and ownership still
  // must not be theirs to hand out.
  {
    const { error: handOut } = await ownerC.from("vendor_users")
      .update({ is_owner: true }).eq("user_id", workerId);
    const { data: after } = await svc.from("vendor_users")
      .select("is_owner").eq("user_id", workerId).single();
    handOut && after?.is_owner === false
      ? ok(`C3b nor can the owner hand ownership out — refused: ${handOut.message.slice(0, 52)}`)
      : bad("C3b OWNERSHIP WAS DELEGATED FROM INSIDE THE VENDOR COMPANY");
  }

  // But changing a colleague's capabilities IS theirs to do — the control
  // above must not have cost them the thing they were given the screen for.
  {
    await ownerC.from("vendor_users")
      .update({ capabilities: ["manage_work", "manage_contracts"] }).eq("user_id", workerId);
    const { data: after } = await svc.from("vendor_users")
      .select("capabilities").eq("user_id", workerId).single();
    (after?.capabilities ?? []).includes("manage_contracts")
      ? ok("C3c while the owner CAN still change what a colleague may do")
      : bad("C3c the owner can no longer manage their own colleagues");
    // Put it back for section B's later expectations.
    await svc.from("vendor_users").update({ capabilities: ["manage_work"] }).eq("user_id", workerId);
  }

  const { error: lastOwner } = await svc.from("vendor_users")
    .delete().eq("user_id", ownerId);
  refused("C4 the last owner cannot be removed even by the service role", lastOwner);

  // A vendor of one company must not reach another's.
  const vendorB = await makeVendor(org.id, "Beta");
  const { error: crossInvite } = await inviteVendorUser(
    ownerC, org.id, vendorB, `probevss.cross.${S}@oegroup.test`, ["manage_work"], ownerId);
  refused("C5 and cannot invite anybody into a different company", crossInvite);

  // The escalation that matters: a vendor must not be able to invite staff.
  const { error: escalate } = await ownerC.from("invitations").insert({
    org_id: org.id, email: `probevss.esc.${S}@oegroup.test`, role: "facility_manager",
    vendor_id: vendorA, vendor_capabilities: ["manage_work"], token_hash: hash(crypto.randomUUID()),
    invited_by: ownerId,
  });
  refused("C6 a vendor cannot invite anything but a vendor", escalate);
}

// ---------------------------------------------------------------------------
console.log("\nD. The registration pack");
// ---------------------------------------------------------------------------
{
  const { error: startErr } = await ownerC.from("vendor_registrations")
    .insert({ org_id: org.id, vendor_id: vendorA, legal_name: `Probe VSS Alpha ${S} Ltd` });
  !startErr ? ok("D1 the vendor starts their own pack") : bad(`D1 — ${startErr.message}`);

  const { data: missing } = await ownerC.rpc("vendor_registration_missing", { p_vendor_id: vendorA });
  (missing?.length ?? 0) > 0
    ? ok(`D2 an incomplete pack names what is left (${missing.length} items)`)
    : bad("D2 an empty pack reported complete");

  const { error: earlySubmit } = await ownerC.rpc("submit_vendor_registration");
  refused("D3 and cannot be submitted", earlySubmit);
  /outstanding/i.test(earlySubmit?.message ?? "")
    ? ok("D4 the refusal says what is outstanding rather than just 'invalid'")
    : bad(`D4 unhelpful refusal: ${earlySubmit?.message ?? "none"}`);

  // Fill it, as the vendor.
  await ownerC.from("vendor_registrations").update({
    legal_name: `Probe VSS Alpha ${S} Ltd`, cac_number: `RC-${S}`, tin: `TIN-${S}`,
    address: "1 Probe Close, Ikeja", phone: "+2348000000000", email: `probevss.${S}@example.com`,
    bank_name: "Probe Bank", account_name: `Probe VSS Alpha ${S} Ltd`, account_number_last4: "1234",
    compliance_statement: "Probe declaration recorded verbatim for the suite.",
    compliance_declared_at: new Date().toISOString(),
  }).eq("vendor_id", vendorA);

  // Documents. Metadata only — the bucket itself is exercised by the app.
  for (const doc of ["cac_certificate", "tin_certificate", "bank_evidence", "proof_of_address"]) {
    await ownerC.from("vendor_documents").insert({
      org_id: org.id, vendor_id: vendorA, doc_type: doc,
      storage_path: `${org.id}/${vendorA}/${doc}-${S}.pdf`, uploaded_by: ownerId,
    });
  }

  const { error: preVerified } = await ownerC.from("vendor_documents").insert({
    org_id: org.id, vendor_id: vendorA, doc_type: "insurance",
    storage_path: `${org.id}/${vendorA}/insurance-${S}.pdf`, uploaded_by: ownerId,
    verified_at: new Date().toISOString(),
  });
  refused("D5 nobody uploads their own evidence pre-verified", preVerified);

  const { error: statusPatch } = await ownerC.from("vendor_registrations")
    .update({ status: "approved" }).eq("vendor_id", vendorA);
  statusPatch || (await svc.from("vendor_registrations").select("status")
    .eq("vendor_id", vendorA).single()).data?.status !== "approved"
    ? ok("D6 a vendor cannot PATCH their own pack to approved")
    : bad("D6 A VENDOR APPROVED THEIR OWN REGISTRATION");

  const { error: submitErr } = await ownerC.rpc("submit_vendor_registration");
  !submitErr ? ok("D7 a complete pack submits") : bad(`D7 — ${submitErr.message}`);

  const { error: noReason } = await adminC.rpc("review_vendor_registration", {
    p_vendor_id: vendorA, p_approve: true, p_notes: "ok",
  });
  refused("D8 approval with no stated reason is refused", noReason);

  const { error: vendorSelfReview } = await ownerC.rpc("review_vendor_registration", {
    p_vendor_id: vendorA, p_approve: true, p_notes: "Reviewed by myself, thanks.",
  });
  refused("D9 and a vendor cannot review their own", vendorSelfReview);

  const { error: reviewErr } = await adminC.rpc("review_vendor_registration", {
    p_vendor_id: vendorA, p_approve: true,
    p_notes: "Documents checked against CAC portal; company confirmed.",
  });
  !reviewErr ? ok("D10 an administrator approves it, with a reason") : bad(`D10 — ${reviewErr.message}`);
}

// ---------------------------------------------------------------------------
console.log("\nE. Cross-brand introduction, without telling either brand about the other");
// ---------------------------------------------------------------------------
{
  const { error: unknownSlug } = await ownerC.rpc("offer_vendor_introduction", {
    p_target_org_slug: `no-such-org-${S}`,
    p_consent_statement: "I consent to sharing my registration with this organisation.",
  });
  const { error: ownOrg } = await ownerC.rpc("offer_vendor_introduction", {
    p_target_org_slug: org.slug,
    p_consent_statement: "I consent to sharing my registration with this organisation.",
  });
  unknownSlug && ownOrg && unknownSlug.message === ownOrg.message
    ? ok("E1 an unknown slug and your own org answer identically (cannot be mapped)")
    : bad(`E1 the two refusals differ — "${unknownSlug?.message}" vs "${ownOrg?.message}"`);

  const { error: noConsent } = await ownerC.rpc("offer_vendor_introduction", {
    p_target_org_slug: otherOrg.slug, p_consent_statement: "ok",
  });
  refused("E2 an offer with no recorded consent wording is refused", noConsent);

  const { data: introId, error: offerErr } = await ownerC.rpc("offer_vendor_introduction", {
    p_target_org_slug: otherOrg.slug,
    p_consent_statement:
      "I consent to sharing my approved registration and its documents with this organisation.",
  });
  !offerErr ? ok("E3 the vendor offers their pack to the other brand") : bad(`E3 — ${offerErr.message}`);

  // The receiving org.
  const otherAdmin = await makeUser(otherOrg.id, "admin", "otheradmin");
  const otherAdminC = await login(otherAdmin.email);

  const { data: pending } = await otherAdminC.rpc("pending_vendor_introductions");
  const row = (pending ?? []).find((p) => p.id === introId);
  row ? ok("E4 the receiving organisation sees the offer") : bad("E4 the offer never arrived");
  if (row) {
    const leaks = Object.keys(row).filter((k) => /source|from_org|origin/i.test(k));
    leaks.length === 0
      ? ok("E5 and is told nothing about which organisation it came from (B1)")
      : bad(`E5 THE SOURCE ORG LEAKED via ${leaks.join(", ")}`);
  }

  // Somebody without vendors.write gets an empty set, not a refusal.
  const nobody = await makeUser(otherOrg.id, "tenant", "othertenant");
  const nobodyC = await login(nobody.email);
  const { data: nothing, error: nothingErr } = await nobodyC.rpc("pending_vendor_introductions");
  !nothingErr && (nothing ?? []).length === 0
    ? ok("E6 a caller without vendors.write gets an empty set, not a refusal")
    : bad(`E6 — ${nothingErr?.message ?? `${nothing?.length} rows returned`}`);

  const { error: strangerAccept } = await nobodyC.rpc("accept_vendor_introduction", { p_id: introId });
  refused("E7 and cannot accept it", strangerAccept);

  const { data: newVendorId, error: acceptErr } = await otherAdminC.rpc("accept_vendor_introduction", {
    p_id: introId,
  });
  if (acceptErr) { bad(`E8 accept failed — ${acceptErr.message}`); }
  else {
    madeVendors.push(newVendorId);
    ok("E8 the receiving organisation takes it on");

    const { data: nv } = await svc.from("vendors").select("org_id, name").eq("id", newVendorId).single();
    eq("E9 the new vendor belongs to the receiving org", nv?.org_id, otherOrg.id);

    const { data: nr } = await svc.from("vendor_registrations")
      .select("status, cac_number, tin, submitted_by, compliance_declared_by")
      .eq("vendor_id", newVendorId).single();
    eq("E10 the pack arrives for review, not pre-approved", nr?.status, "submitted");
    eq("E11 with the vendor's own details carried over", nr?.cac_number, `RC-${S}`);
    nr?.submitted_by === null && nr?.compliance_declared_by === null
      ? ok("E12 and no foreign-org user id planted in the receiving org's row")
      : bad(`E12 a source-org user id crossed — submitted_by=${nr?.submitted_by}`);

    const { data: nd } = await svc.from("vendor_documents")
      .select("doc_type, verified_at, copied_at, source_document_id, storage_path")
      .eq("vendor_id", newVendorId);
    eq("E13 the four compulsory documents came with it", nd?.length, 4);
    (nd ?? []).every((d) => d.verified_at === null)
      ? ok("E14 none of them arrive pre-verified — one org's check is not another's")
      : bad("E14 A VERIFICATION CROSSED THE BOUNDARY");
    (nd ?? []).every((d) => d.storage_path.startsWith(`${otherOrg.id}/`))
      ? ok("E15 every file path is under the receiving org's own prefix")
      : bad("E15 a document still points into the source org's storage prefix");
    (nd ?? []).every((d) => d.copied_at === null && d.source_document_id)
      ? ok("E16 and each is queued for the service-role file copy")
      : bad("E16 documents were not queued for transfer");

    const { data: queue } = await svc.rpc("pending_vendor_document_copies");
    (queue ?? []).some((q) => q.target_path.startsWith(`${otherOrg.id}/`))
      ? ok("E17 the transfer queue names both paths, for the service role only")
      : bad("E17 the transfer queue is empty");

    const { error: queuePeek } = await otherAdminC.rpc("pending_vendor_document_copies");
    refused("E18 which no signed-in user may read", queuePeek);
  }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
for (const id of madeVendors) {
  await svc.from("vendor_introductions").delete().eq("source_vendor_id", id);
  await svc.from("vendor_introductions").delete().eq("target_vendor_id", id);
  await svc.from("vendor_documents").delete().eq("vendor_id", id);
  await svc.from("vendor_registrations").delete().eq("vendor_id", id);
  await svc.from("payments").delete().eq("vendor_id", id);
  await svc.from("tickets").delete().eq("assigned_vendor_id", id);
  await svc.from("vendor_users").update({ is_owner: false }).eq("vendor_id", id);
  await svc.from("vendor_users").delete().eq("vendor_id", id);
  await svc.from("invitations").delete().eq("vendor_id", id);
  await svc.from("vendors").delete().eq("id", id);
}
for (const id of madeUsers) {
  await svc.from("users").delete().eq("id", id);
  await svc.auth.admin.deleteUser(id).catch(() => {});
}

console.log(failures === 0
  ? "\n\x1b[32mAll vendor self-service checks passed.\x1b[0m\n"
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
