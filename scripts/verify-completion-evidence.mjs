import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// dotenv, not a hand-rolled line parser. The previous one matched
// /^([A-Z0-9_]+)=(.*)$/ against each line of a CRLF .env.local - and JS `.`
// does not match a carriage return, so every line ending in one failed to
// match and the file parsed as empty. The suite then died on "supabaseUrl is
// required." as though the environment were unconfigured. Every other suite
// here uses dotenv; these two were the only holdouts.
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PW = "Probe-" + crypto.randomUUID();

const { data: org } = await svc.from("orgs").select("id").eq("slug", "tfml").single();
const { data: oeaOrg } = await svc.from("orgs").select("id").eq("slug", "oea").single();

// ── Build one real, throwaway vendor login (cleaned up at the end) ─────────
const probeEmail = `probe-vendor-0140-${Date.now()}@oegroup.test`;
const { data: created, error: createErr } = await svc.auth.admin.createUser({
  email: probeEmail, password: PW, email_confirm: true,
});
if (createErr) { console.error("could not create probe auth user:", createErr.message); process.exit(1); }
const probeUserId = created.user.id;

await svc.from("users").insert({ id: probeUserId, org_id: org.id, role: "vendor", email: probeEmail, full_name: "Probe Vendor 0140" });
const { data: vendorRow, error: vendorErr } = await svc.from("vendors").insert({
  org_id: org.id, name: "Probe Vendor Co 0140", user_id: probeUserId, service_category: "cleaning", status: "active",
}).select("id").single();
if (vendorErr) console.error("could not create probe vendors row:", vendorErr.message);
console.log("probe vendor ready:", probeEmail, "-> vendors.id", vendorRow?.id);

/**
 * ⚠️ This used to `delete()` all three and print "fully removed" without
 * checking a single error — and it was wrong. Submitting an invoice writes
 * `payment.created` to `audit_log` with this user as `actor_id`, and
 * `audit_log_actor_id_fkey` then refuses to let the `users` row go. That is
 * the audit trail working exactly as designed (0026: "anyone who has
 * performed an audited action ... must remain, or the audit trail develops
 * holes") — so the delete silently failed, the script claimed success, and a
 * stranded vendor-role profile sat in TFML until a later sweep found it.
 *
 * The right disposition for a fixture that has acted is the one the product
 * itself uses for a real person who has acted: DEACTIVATE. Errors are checked
 * now, and the script says what actually happened rather than what it hoped.
 */
async function cleanup() {
  if (vendorRow) {
    const { error } = await svc.from("vendors").delete().eq("id", vendorRow.id);
    if (error) console.error("  ! vendors row not removed:", error.message);
  }
  const { error: delErr } = await svc.from("users").delete().eq("id", probeUserId);
  if (delErr) {
    // Expected whenever the run reached section A — it audited something.
    const { error: deactErr } = await svc.from("users")
      .update({ deactivated_at: new Date().toISOString(), full_name: "RETIRED test fixture (completion-evidence)" })
      .eq("id", probeUserId);
    console.log(
      deactErr
        ? `\n⚠️ probe profile could NOT be removed or deactivated: ${deactErr.message}`
        : "\nprobe vendor removed; its profile is retained but DEACTIVATED (it has audit rows, which must not be orphaned)."
    );
  } else {
    const { error: authErr } = await svc.auth.admin.deleteUser(probeUserId);
    console.log(
      authErr
        ? `\nprobe profile removed; auth login remains: ${authErr.message}`
        : "\nprobe vendor + login fully removed."
    );
  }
}

const vendor = createClient(url, anon);
const { error: signInErr } = await vendor.auth.signInWithPassword({ email: probeEmail, password: PW });
console.log("\n=== A. Vendor submits invoice with their own attachment ===");
console.log("sign in as the probe vendor:", signInErr ? `FAIL ${signInErr.message}` : "PASS");

if (signInErr) { await cleanup(); process.exit(1); }

const goodPath = `${org.id}/${crypto.randomUUID()}.jpg`;
const tinyJpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const { error: upErr } = await vendor.storage.from("invoice-attachments").upload(goodPath, tinyJpeg, { contentType: "image/jpeg" });
console.log("vendor uploads to their own org prefix:", upErr ? `FAIL ${upErr.message}` : "PASS");

const { data: paymentId, error: submitErr } = await vendor.rpc("submit_vendor_invoice", {
  p_amount: 12345, p_invoice_reference: "TESTINV-0140-A", p_ticket_id: null, p_attachment_path: goodPath,
});
console.log("submit_vendor_invoice with own-org attachment:", submitErr ? `FAIL ${submitErr.message}` : `PASS (id ${paymentId})`);

if (paymentId) {
  const { data: row } = await svc.from("payments").select("invoice_attachment_path").eq("id", paymentId).single();
  console.log("stored path matches upload:", row?.invoice_attachment_path === goodPath ? "PASS" : `FAIL (${row?.invoice_attachment_path})`);

  const { error: signErr } = await vendor.storage.from("invoice-attachments").createSignedUrl(goodPath, 60);
  console.log("vendor can sign a URL for their own invoice attachment:", signErr ? `FAIL ${signErr.message}` : "PASS");

  const otherVendor = createClient(url, anon);
  const { error: otherSignIn } = await otherVendor.auth.signInWithPassword({ email: "oea.vendor@oegroup.test", password: "OEGroupDemo2026!" });
  if (!otherSignIn) {
    const { error: crossErr } = await otherVendor.storage.from("invoice-attachments").createSignedUrl(goodPath, 60);
    console.log("a DIFFERENT org's vendor is refused signing it:", crossErr ? "PASS (refused)" : "FAIL (should have been refused!)");
    await otherVendor.auth.signOut();
  } else {
    console.log("skip cross-org check: oea.vendor@oegroup.test sign-in failed (", otherSignIn.message, ")");
  }

  await svc.from("payments").delete().eq("id", paymentId);
}
await svc.storage.from("invoice-attachments").remove([goodPath]);

console.log("\n=== B. Vendor claims a path under ANOTHER org's prefix ===");
const badPath = `${oeaOrg.id}/fake.jpg`;
const { error: badErr } = await vendor.rpc("submit_vendor_invoice", {
  p_amount: 1000, p_invoice_reference: "TESTINV-0140-B", p_ticket_id: null, p_attachment_path: badPath,
});
console.log("refused (does not belong to your organisation):", badErr ? `PASS (${badErr.message})` : "FAIL (should have been refused!)");

console.log("\n=== C. Old call shape (no attachment) still works — the overload fix ===");
const { data: legacyId, error: legacyErr } = await vendor.rpc("submit_vendor_invoice", {
  p_amount: 500, p_invoice_reference: "TESTINV-0140-C", p_ticket_id: null,
});
console.log("call without p_attachment_path at all:", legacyErr ? `FAIL ${legacyErr.message}` : `PASS (id ${legacyId})`);
if (legacyId) await svc.from("payments").delete().eq("id", legacyId);

console.log("\n=== D. Fewer arguments still (2 required only) ===");
const { data: minimalId, error: minimalErr } = await vendor.rpc("submit_vendor_invoice", {
  p_amount: 250, p_invoice_reference: "TESTINV-0140-D",
});
console.log("call with only the 2 required args:", minimalErr ? `FAIL ${minimalErr.message}` : `PASS (id ${minimalId})`);
if (minimalId) await svc.from("payments").delete().eq("id", minimalId);

await vendor.auth.signOut();
await cleanup();
