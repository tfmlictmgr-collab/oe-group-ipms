// Work-order evidence: who may attach it, who may see it, and what becomes of
// it once the job is done (0106).
//
// The load-bearing claim under test is the one the migration is built on:
// an attachment's visibility is NOT re-derived, it FOLLOWS ITS TICKET. Section
// A proves that in both directions against a real second tenant, because a
// policy that merely looks like it inherits is worth nothing.
//
// Usage: node scripts/verify-work-order-media.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const PASSWORD = "OEGroupDemo2026!";
async function login(email) {
  const c = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return c;
}

const MARK = "PROBEMEDIA";
const stamp = Date.now().toString(36).toUpperCase().slice(-5);

// Start-of-run sweep. End-of-run cleanup cannot fix a run that died before
// reaching it — the standing lesson from probe-cleanup.mjs. Storage objects
// too, since sections I/J (added for audit 0805-H1) upload real bytes that a
// crashed prior run would leave behind — a stray file in a private evidence
// bucket outlives the ticket row that would otherwise have hinted at it.
{
  const { data: strays } = await svc.from("tickets").select("id").like("message_text", `${MARK}%`);
  if (strays?.length) {
    await svc.from("ticket_attachments").delete().in("ticket_id", strays.map((s) => s.id));
    await svc.from("tickets").delete().in("id", strays.map((s) => s.id));
    console.log(`(swept ${strays.length} ticket(s) left by an earlier run)`);
  }
  const { data: pocForSweep } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
  const { data: strayFolders } = await svc.storage.from("work-order-media").list(pocForSweep.id);
  const strayTicketDirs = (strayFolders ?? []).filter((f) => !f.id).map((f) => f.name);
  for (const dir of strayTicketDirs) {
    const { data: files } = await svc.storage.from("work-order-media").list(`${pocForSweep.id}/${dir}`);
    const strayFiles = (files ?? []).filter((f) => f.name.startsWith(`${MARK}-`)).map((f) => `${pocForSweep.id}/${dir}/${f.name}`);
    if (strayFiles.length) {
      await svc.storage.from("work-order-media").remove(strayFiles);
      console.log(`(swept ${strayFiles.length} stray object(s) under ${dir})`);
    }
  }
}

const { data: poc } = await svc.from("orgs").select("id").eq("slug", "oe-group-foundation-poc").single();
const { data: tenant } = await svc.from("users").select("id, email")
  .eq("email", "oe-group-foundation-poc.tenant@oegroup.test").single();
const { data: fm } = await svc.from("users").select("id, email")
  .eq("email", "oe-group-foundation-poc.facilitymanager@oegroup.test").single();
const { data: others } = await svc.from("users").select("id, email")
  .eq("org_id", poc.id).eq("role", "tenant").is("deactivated_at", null).neq("id", tenant.id).limit(1);
const otherTenant = others?.[0] ?? null;

const made = [];
// Real storage objects uploaded in sections I/J — not FK-linked to `tickets`,
// so deleting the ticket rows below does not remove these on its own.
const madeObjects = [];
async function makeTicket(status = "open", extra = {}) {
  const { data, error } = await svc.from("tickets").insert({
    org_id: poc.id, channel: "portal", sender_id: tenant.id,
    message_text: `${MARK}-${stamp}`, category: "maintenance", urgency: "normal",
    status, ...extra,
  }).select("id").single();
  if (error) throw new Error(`fixture ticket: ${error.message}`);
  made.push(data.id);
  return data.id;
}

/** An index row, written as the service role — the file itself is not the subject here. */
async function attach(ticketId, uploadedBy, suffix = "") {
  const { data, error } = await svc.from("ticket_attachments").insert({
    org_id: poc.id, ticket_id: ticketId,
    storage_path: `${poc.id}/${ticketId}/${MARK}-${stamp}${suffix}.jpg`,
    file_name: `${MARK}${suffix}.jpg`, content_type: "image/jpeg",
    size_bytes: 2048, uploaded_by: uploadedBy,
  }).select("id").single();
  if (error) throw new Error(`fixture attachment: ${error.message}`);
  return data.id;
}

console.log("Work-order evidence — attached to the job, visible with the job\n");

console.log("A. Visibility follows the ticket, rather than being re-derived");
{
  const ticketId = await makeTicket();
  const attId = await attach(ticketId, tenant.id);

  const c = await login(tenant.email);
  const { data: mine } = await c.from("ticket_attachments").select("id").eq("id", attId);
  (mine ?? []).length === 1
    ? ok("the tenant who raised the request sees the evidence on it")
    : bad("THE REPORTER CANNOT SEE EVIDENCE ON THEIR OWN REQUEST");
  await c.auth.signOut();

  // ⚠️ This pair must be tested on a ticket the FM/PM can ACTUALLY SEE.
  // The first version of this section used the unfiled ticket above and
  // asserted "sees as much evidence as ticket" — which passed at 0 : 0,
  // because a property-scoped FM cannot see a ticket with no property
  // (the 0064 triage boundary). A test satisfied by both numbers being
  // zero proves nothing about inheritance. So: file the ticket against a
  // property this FM genuinely holds, resolved from THEIR OWN read rather
  // than assumed, and require 1 : 1.
  const f = await login(fm.email);
  const { data: reachable } = await f.from("tickets")
    .select("property_id").not("property_id", "is", null).limit(1).maybeSingle();

  if (reachable?.property_id) {
    const filedId = await makeTicket("open", { property_id: reachable.property_id });
    const filedAtt = await attach(filedId, tenant.id, "-filed");

    const { data: fmTicket } = await f.from("tickets").select("id").eq("id", filedId);
    const { data: fmSees } = await f.from("ticket_attachments").select("id").eq("id", filedAtt);
    (fmTicket ?? []).length === 1 && (fmSees ?? []).length === 1
      ? ok("the FM/PM sees a filed request AND its evidence — inheritance proved positively, 1 : 1")
      : bad(`MISMATCH — FM/PM sees ${(fmTicket ?? []).length} ticket(s) but ${(fmSees ?? []).length} attachment(s)`);

    // The other half of the same claim: where the ticket is invisible, so is
    // the evidence — for the SAME person, on the same run.
    const { data: unfiledTicket } = await f.from("tickets").select("id").eq("id", ticketId);
    const { data: unfiledAtt } = await f.from("ticket_attachments").select("id").eq("id", attId);
    (unfiledTicket ?? []).length === 0 && (unfiledAtt ?? []).length === 0
      ? ok("and on an unfiled request they cannot reach, neither — 0 : 0 for the same reason")
      : bad(`MISMATCH on the unfiled request — ${(unfiledTicket ?? []).length} : ${(unfiledAtt ?? []).length}`);
  } else {
    bad("no property-scoped ticket reachable by the FM/PM — cannot prove inheritance positively");
  }
  await f.auth.signOut();

  if (otherTenant) {
    const o = await login(otherTenant.email);
    const { data: theirTicket } = await o.from("tickets").select("id").eq("id", ticketId);
    const { data: theirAtt } = await o.from("ticket_attachments").select("id").eq("id", attId);
    (theirTicket ?? []).length === 0 && (theirAtt ?? []).length === 0
      ? ok("an unrelated tenant sees neither the request nor its evidence — the same answer to both")
      : bad(`LEAK — unrelated tenant saw ${(theirTicket ?? []).length} ticket(s), ${(theirAtt ?? []).length} attachment(s)`);
    await o.auth.signOut();
  } else {
    console.log("  (skipped — no second tenant on this org to test isolation with)");
  }
}

console.log("\nB. Evidence is attached while the work is live, not after it is judged");
{
  const openId = await makeTicket("open");
  const doneId = await makeTicket("resolved", {
    first_response_at: new Date(Date.now() - 3600e3).toISOString(),
    resolved_at: new Date().toISOString(),
  });

  const c = await login(tenant.email);
  const row = (ticketId) => ({
    org_id: poc.id, ticket_id: ticketId,
    storage_path: `${poc.id}/${ticketId}/${MARK}-${stamp}-live.jpg`,
    file_name: `${MARK}.jpg`, content_type: "image/jpeg", size_bytes: 999, uploaded_by: tenant.id,
  });

  const { error: openErr } = await c.from("ticket_attachments").insert(row(openId));
  !openErr
    ? ok("evidence attaches to an open request")
    : bad(`could not attach to an OPEN request: ${openErr.message}`);

  const { error: doneErr } = await c.from("ticket_attachments").insert(row(doneId));
  doneErr
    ? ok("and is refused on a resolved one — it may already have been evaluated against")
    : bad("EVIDENCE WAS ADDED TO A RESOLVED REQUEST, after the work was judged");
  await c.auth.signOut();
}

console.log("\nC. A row cannot lie about who wrote it, or where it belongs");
{
  const ticketId = await makeTicket();
  const c = await login(tenant.email);

  const { error: whoErr } = await c.from("ticket_attachments").insert({
    org_id: poc.id, ticket_id: ticketId,
    storage_path: `${poc.id}/${ticketId}/${MARK}-${stamp}-forged.jpg`,
    file_name: "forged.jpg", content_type: "image/jpeg", size_bytes: 100,
    uploaded_by: fm.id,                       // not the caller
  });
  whoErr
    ? ok("attributing an upload to another person is refused")
    : bad("EVIDENCE WAS ATTRIBUTED TO SOMEONE WHO DID NOT UPLOAD IT");

  const { data: otherOrg } = await svc.from("orgs").select("id")
    .neq("id", poc.id).is("deleted_at", null).limit(1).single();
  const { error: orgErr } = await c.from("ticket_attachments").insert({
    org_id: otherOrg.id,                      // not the caller's org
    ticket_id: ticketId,
    storage_path: `${otherOrg.id}/${ticketId}/${MARK}-${stamp}-cross.jpg`,
    file_name: "cross.jpg", content_type: "image/jpeg", size_bytes: 100,
    uploaded_by: tenant.id,
  });
  orgErr
    ? ok("filing evidence into another organisation is refused")
    : bad("EVIDENCE WAS FILED INTO ANOTHER ORGANISATION");
  await c.auth.signOut();
}

console.log("\nD. Evidence is append-only — it cannot be edited into something else");
{
  const ticketId = await makeTicket();
  const attId = await attach(ticketId, tenant.id, "-edit");

  const c = await login(tenant.email);
  const { data: updated } = await c.from("ticket_attachments")
    .update({ file_name: "rewritten.jpg", size_bytes: 1 }).eq("id", attId).select("id");
  (updated ?? []).length === 0
    ? ok("an update affects no rows — there is no UPDATE policy at all")
    : bad("AN ATTACHMENT RECORD WAS REWRITTEN AFTER THE FACT");

  const { data: check } = await svc.from("ticket_attachments")
    .select("file_name").eq("id", attId).single();
  check.file_name.startsWith(MARK)
    ? ok("and the stored row is unchanged")
    : bad(`the row WAS changed: ${check.file_name}`);
  await c.auth.signOut();
}

console.log("\nE. Removing is your own mistake, briefly — not editing the record");
{
  const ticketId = await makeTicket();
  const mineId = await attach(ticketId, tenant.id, "-mine");
  const theirsId = await attach(ticketId, fm.id, "-theirs");

  const c = await login(tenant.email);

  const { data: gone } = await c.from("ticket_attachments").delete().eq("id", mineId).select("id");
  (gone ?? []).length === 1
    ? ok("the uploader can remove their own upload while the job is open")
    : bad("an uploader could not remove their own mistaken upload");

  const { data: notYours } = await c.from("ticket_attachments").delete().eq("id", theirsId).select("id");
  (notYours ?? []).length === 0
    ? ok("but not somebody else's")
    : bad("ONE PERSON DELETED ANOTHER PERSON'S EVIDENCE");
  await c.auth.signOut();

  // And once the job is done, not even your own.
  const doneTicket = await makeTicket("open");
  const lateId = await attach(doneTicket, tenant.id, "-late");
  await svc.from("tickets").update({
    status: "resolved", resolved_at: new Date().toISOString(),
  }).eq("id", doneTicket);

  const c2 = await login(tenant.email);
  const { data: tooLate } = await c2.from("ticket_attachments").delete().eq("id", lateId).select("id");
  (tooLate ?? []).length === 0
    ? ok("and once the job is resolved it belongs to the record, not the uploader")
    : bad("EVIDENCE WAS DELETED FROM A RESOLVED JOB — after it could have been evaluated against");
  await c2.auth.signOut();
}

console.log("\nF. The index will not admit something it cannot show");
{
  const ticketId = await makeTicket();
  const { error } = await svc.from("ticket_attachments").insert({
    org_id: poc.id, ticket_id: ticketId,
    storage_path: `${poc.id}/${ticketId}/${MARK}-${stamp}.pdf`,
    file_name: "invoice.pdf", content_type: "application/pdf", size_bytes: 500,
    uploaded_by: tenant.id,
  });
  error
    ? ok("a PDF is refused — this is photo/video evidence, not a document store")
    : bad("A NON-MEDIA FILE WAS INDEXED as work-order evidence");

  const { error: zeroErr } = await svc.from("ticket_attachments").insert({
    org_id: poc.id, ticket_id: ticketId,
    storage_path: `${poc.id}/${ticketId}/${MARK}-${stamp}-empty.jpg`,
    file_name: "empty.jpg", content_type: "image/jpeg", size_bytes: 0,
    uploaded_by: tenant.id,
  });
  zeroErr
    ? ok("and a zero-byte file is refused — an empty photo is a failed upload")
    : bad("a zero-byte attachment was accepted");
}

console.log("\nG. The bucket is private, and bounded");
{
  const { data: bucket } = await svc.storage.getBucket("work-order-media");
  bucket && bucket.public === false
    ? ok("work-order-media is private — a photo of someone's home is not a public URL")
    : bad("THE EVIDENCE BUCKET IS PUBLIC");
  bucket?.file_size_limit === 26214400
    ? ok("with a 25 MB ceiling enforced by the bucket, not only by the browser")
    : bad(`unexpected size limit: ${bucket?.file_size_limit}`);
  (bucket?.allowed_mime_types ?? []).every((m) => m.startsWith("image/") || m.startsWith("video/"))
    ? ok("and accepts only image and video types")
    : bad(`bucket admits non-media: ${JSON.stringify(bucket?.allowed_mime_types)}`);
}

console.log("\nH. Every attachment is on the audit trail");
{
  const ticketId = await makeTicket();
  const attId = await attach(ticketId, tenant.id, "-audit");
  const { data: entries } = await svc.from("audit_log")
    .select("id, action").eq("entity_type", "ticket_attachments").eq("entity_id", attId);
  (entries ?? []).length >= 1
    ? ok(`recorded as ${entries[0].action}`)
    : bad("AN ATTACHMENT WAS ADDED WITH NO AUDIT RECORD");
}

// A tiny real JPEG-shaped buffer — small enough to upload instantly, real
// enough for storage.objects to hold and serve. Content correctness is not
// the point; existence at a real path is, since sections I/J exercise the
// BYTES layer, not the index row.
const TINY_FILE = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

console.log("\nI. Audit 0805-H1 — the storage OBJECT is scoped to the ticket, not just the org");
console.log("   (the fix, and the exact leak it closes: before it, any authenticated org");
console.log("   member could sign or list ANY other ticket's evidence directly via Storage)");
{
  const ticketId = await makeTicket();
  const objectPath = `${poc.id}/${ticketId}/${MARK}-${stamp}-storage.jpg`;

  const { error: upErr } = await svc.storage.from("work-order-media")
    .upload(objectPath, TINY_FILE, { contentType: "image/jpeg" });
  if (upErr) throw new Error(`fixture upload: ${upErr.message}`);
  madeObjects.push(objectPath);

  const attId = await attach(ticketId, tenant.id, "-storage");
  // Re-point the fixture's index row at the REAL object path (attach() mints
  // its own path by convention; this test needs the row and the object to
  // agree, since the whole point is that the policy joins on storage_path).
  await svc.from("ticket_attachments").update({ storage_path: objectPath }).eq("id", attId);

  const c = await login(tenant.email);
  const { data: signedForOwner, error: ownerErr } = await c.storage
    .from("work-order-media").createSignedUrl(objectPath, 60);
  signedForOwner && !ownerErr
    ? ok("the ticket's own sender can sign the object directly")
    : bad(`the sender could not sign their own evidence: ${ownerErr?.message}`);
  await c.auth.signOut();

  if (otherTenant) {
    const o = await login(otherTenant.email);

    const { data: signedForOther, error: otherSignErr } = await o.storage
      .from("work-order-media").createSignedUrl(objectPath, 60);
    (!signedForOther && otherSignErr) || (signedForOther && !signedForOther.signedUrl)
      ? ok("an unrelated same-org tenant CANNOT sign the object — the H1 leak is closed")
      : bad("!!! H1 REGRESSION — an unrelated tenant signed another ticket's evidence directly");

    const { data: listing } = await o.storage.from("work-order-media").list(`${poc.id}/${ticketId}`);
    (listing ?? []).length === 0
      ? ok("and cannot list the ticket's evidence folder either")
      : bad(`!!! an unrelated tenant listed ${listing.length} file(s) in another ticket's folder`);

    await o.auth.signOut();
  } else {
    console.log("  (skipped — no second tenant on this org to test the leak with)");
  }

  // The row is the authority; an object with no row pointing at it (upload
  // succeeded, recordAttachment() never ran or was refused) must be unreadable
  // to EVERYONE, including the person who uploaded it under their own session
  // — the whole reason recordAttachment() removes an orphaned object on
  // refusal rather than leaving it recoverable.
  const orphanPath = `${poc.id}/${ticketId}/${MARK}-${stamp}-orphan.jpg`;
  await svc.storage.from("work-order-media").upload(orphanPath, TINY_FILE, { contentType: "image/jpeg" });
  const c2 = await login(tenant.email);
  const { data: orphanSigned } = await c2.storage.from("work-order-media").createSignedUrl(orphanPath, 60);
  !orphanSigned?.signedUrl
    ? ok("an object with no ticket_attachments row is unreadable, even to its own uploader")
    : bad("!!! AN ORPHANED OBJECT (no index row) WAS SIGNED — the policy is keying off the wrong thing");
  await c2.auth.signOut();
  await svc.storage.from("work-order-media").remove([orphanPath]);
}

console.log("\nJ. The storage DELETE policy matches the row's own rule, not Storage's default ownership");
{
  const ticketId = await makeTicket("open");
  const objectPath = `${poc.id}/${ticketId}/${MARK}-${stamp}-delete.jpg`;
  await svc.storage.from("work-order-media").upload(objectPath, TINY_FILE, { contentType: "image/jpeg" });
  // Deliberately not removed by the tenant in this section — that failing IS
  // the assertion. Service role cleans it up at the end, same as any other
  // fixture object.
  madeObjects.push(objectPath);
  const attId = await attach(ticketId, tenant.id, "-delete");
  await svc.from("ticket_attachments").update({ storage_path: objectPath }).eq("id", attId);

  await svc.from("tickets").update({
    status: "resolved", resolved_at: new Date().toISOString(),
  }).eq("id", ticketId);

  const c = await login(tenant.email);
  const { error: delErr } = await c.storage.from("work-order-media").remove([objectPath]);
  const { data: stillThere } = await svc.storage.from("work-order-media")
    .list(`${poc.id}/${ticketId}`, { search: objectPath.split("/").pop() });

  (stillThere ?? []).length === 1
    ? ok("the object survives — its owner cannot delete it once the job is resolved (0107)")
    : bad("!!! THE STORAGE OBJECT WAS DELETED from a resolved job by its own uploader — the row/object rule now disagree");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
// Storage objects first — they are not FK-linked to `tickets`, so deleting
// the ticket rows below would otherwise leave them stranded, the exact
// "a run that died before reaching cleanup leaves debris behind" class this
// suite's own start-of-run sweep exists to catch on the NEXT run.
if (madeObjects.length) await svc.storage.from("work-order-media").remove(madeObjects);
await svc.from("ticket_attachments").delete().in("ticket_id", made);
await svc.from("tickets").delete().in("id", made);
console.log("\n(cleaned up)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — evidence is visible with its job, attributable, and fixed once the job is judged."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
