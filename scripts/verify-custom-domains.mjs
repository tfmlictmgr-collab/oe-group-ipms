// A hostname resolves one organisation, and never grants anything.
//
// The claims that matter:
//   • a host resolves at most one org and cannot be made to list
//   • an unknown host resolves nothing, so hostnames cannot be enumerated
//   • port and case are normalised, or valid requests silently miss
//   • only an operator may bind a domain; a tenant admin cannot claim one
//   • two orgs cannot answer on the same host
//   • a URL or a path is refused rather than stored and never matched
//   • binding is audited
//   • a retired org's domain stops resolving
//
// Usage: node scripts/verify-custom-domains.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVCK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PW = "OEGroupDemo2026!";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

const svc = createClient(URL_, SVCK, { auth: { persistSession: false } });
const login = async (email) => {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PW });
  return error ? null : c;
};

// ⚠️ THIS SUITE OWNS ITS ORGANISATIONS (11 Sept 2026).
//
// It used to rebind the REAL TFML and OEA organisations to probe hostnames,
// retire the real OEA org in section E, and put everything back at the end.
// On 11 Sept a run was killed by the runner's 300-second budget before its
// restore, and both brands' live front doors — oeaportal.com, tfmlportal.com —
// were left bound to `probe-portal.*.test`: every visitor to either portal got
// the generic OE Group door, in blue, with nothing to say why. The audit trail
// shows the same rebind-and-restore on every run since 28 Aug. Had a run died
// between section E's retire and un-retire, the whole OEA portal would have
// been OFF for every user.
//
// 📌 Decision 38's lesson, and this build's own (verify-offline-payments §K):
// a fixture that relies on its own teardown to undo production-shaped damage
// has made cleanup a correctness requirement — and the runner's time budget is
// exactly the thing that skips cleanup. So nothing here touches an org it did
// not create. Two `direct` probe orgs are provisioned through the operator's
// own RPC and retired at the end; a run that dies leaves probe orgs holding
// `.test` hostnames, which resolve nobody real. A sweep at the start retires
// any a previous crash left live.
const STAMP = Date.now().toString(36).toUpperCase().slice(-6);
const tok = () => crypto.randomBytes(24).toString("hex");

const operator = await login("platform@oegroup.test");
if (!operator) {
  console.error("could not sign in as the platform administrator");
  process.exit(1);
}

{
  const { data: stale } = await svc
    .from("orgs").select("id").like("name", "PROBEDOMAIN-%").is("deleted_at", null);
  for (const o of stale ?? []) {
    await operator.rpc("retire_org", {
      p_org_id: o.id, p_reason: "Sweeping a probe org a previous domain run left live.",
    });
  }
  if ((stale ?? []).length) console.log(`(swept ${stale.length} probe org(s) a previous run left live)`);
}

async function provisionProbe(tag) {
  const { data: id, error } = await operator.rpc("operator_provision_org", {
    p_name: `PROBEDOMAIN-${tag}-${STAMP}`,
    p_delivery_brand: "direct",
    p_admin_email: `probedomain.${tag.toLowerCase()}.${STAMP.toLowerCase()}@example.com`,
    p_admin_name: `Probe ${tag}`,
    p_reason: "verification: a throwaway org to bind probe hostnames to",
    p_token_hash: tok(),
  });
  if (error || !id) {
    console.error(`could not provision a probe org — ${error?.message}`);
    process.exit(1);
  }
  const { data } = await svc.from("orgs").select("id, name, slug").eq("id", id).single();
  return data;
}

// "tfml"/"oea" are kept as variable names so the checks below read as they
// always did — two organisations; which brand never mattered to what a
// hostname is allowed to do.
const tfml = await provisionProbe("T");
const oea = await provisionProbe("O");
const HOST_T = `probe-${STAMP.toLowerCase()}-t.portal.test`;
const HOST_O = `probe-${STAMP.toLowerCase()}-o.portal.test`;

console.log("Hostnames resolve one organisation, and grant nothing\n");

console.log("A. Only an operator may bind a domain");
{
  const brand = await login("tfml.admin@oegroup.test");
  if (!brand) bad("could not sign in as the TFML administrator");
  else {
    // Aimed at the admin's OWN org — the case that matters — but only ever with
    // a probe hostname, and both attempts must FAIL. A success is itself the
    // defect being reported, and is undone immediately below rather than at
    // the end of a run that may not reach the end.
    const { data: own } = await svc.from("users").select("org_id")
      .eq("email", "tfml.admin@oegroup.test").single();
    const { data: before } = await svc.from("orgs").select("custom_domain").eq("id", own.org_id).single();
    const { error } = await brand.rpc("set_org_domain", {
      p_org_id: own.org_id, p_domain: HOST_T,
      p_reason: "A tenant claiming its own hostname.",
    });
    error ? ok("a brand administrator cannot bind a domain, even to their own org")
          : bad("A TENANT ADMIN CLAIMED A HOSTNAME");

    // Nor by writing the column directly — 0083c's allowlist must not include it.
    const { data: patched } = await brand
      .from("orgs").update({ custom_domain: HOST_T }).eq("id", own.org_id).select("id");
    (patched ?? []).length === 0
      ? ok("nor write the column directly")
      : bad("A TENANT ADMIN PATCHED custom_domain");
    const { data: after } = await svc.from("orgs").select("custom_domain").eq("id", own.org_id).single();
    if (after?.custom_domain !== before?.custom_domain) {
      await svc.from("orgs").update({ custom_domain: before?.custom_domain ?? null }).eq("id", own.org_id);
    }
    await brand.auth.signOut();
  }

  const op = await login("platform@oegroup.test");
  if (!op) bad("could not sign in as the platform administrator");
  else {
    const { error } = await op.rpc("set_org_domain", {
      p_org_id: tfml.id, p_domain: HOST_T,
      p_reason: "Binding the TFML portal hostname for verification.",
    });
    error ? bad(`the operator could not bind — ${error.message.slice(0, 70)}`)
          : ok("the operator can");

    // A reason is required, as with every other operator act.
    const { error: noReason } = await op.rpc("set_org_domain", {
      p_org_id: oea.id, p_domain: HOST_O, p_reason: "x",
    });
    noReason ? ok("and must say why") : bad("A DOMAIN WAS BOUND WITH NO REASON");

    await op.rpc("set_org_domain", {
      p_org_id: oea.id, p_domain: HOST_O,
      p_reason: "Binding the OEA portal hostname for verification.",
    });
    await op.auth.signOut();
  }
}

console.log("\nB. A host resolves exactly one organisation");
{
  const one = async (host) => {
    const { data } = await svc.rpc("org_branding_by_host", { p_host: host });
    return data ?? [];
  };

  const t = await one(HOST_T);
  t.length === 1 && t[0].id === tfml.id
    ? ok("the first probe host resolves its own org, one row")
    : bad(`the TFML host returned ${t.length} row(s)`);

  const o = await one(HOST_O);
  o.length === 1 && o[0].id === oea.id
    ? ok("the second probe host resolves its own org, one row")
    : bad(`the OEA host returned ${o.length} row(s)`);

  (await one("nothing-here.example.test")).length === 0
    ? ok("an unknown host resolves nothing — hostnames cannot be enumerated")
    : bad("AN UNKNOWN HOST RESOLVED AN ORGANISATION");

  // Wildcards and quotes must match literally, not pattern-match.
  for (const probe of ["%", "%.test", "' or '1'='1", `_${HOST_T.slice(1)}`]) {
    const r = await one(probe);
    r.length === 0
      ? ok(`"${probe.slice(0, 24)}" matches literally and returns nothing`)
      : bad(`INJECTION-SHAPED HOST "${probe}" RETURNED ${r.length} ROW(S)`);
  }

  // Case and port normalisation — a miss here sends a valid request to the
  // generic door and nobody would know why.
  (await one(HOST_T.toUpperCase())).length === 1
    ? ok("an upper-case host still resolves")
    : bad("CASE BROKE THE MATCH");
  (await one(`${HOST_T}:3000`)).length === 1
    ? ok("a host carrying a port still resolves")
    : bad("A PORT BROKE THE MATCH");
}

console.log("\nC. One host, one organisation");
{
  const op = await login("platform@oegroup.test");
  const { error } = await op.rpc("set_org_domain", {
    p_org_id: oea.id, p_domain: HOST_T,
    p_reason: "Attempting to claim a hostname already bound elsewhere.",
  });
  error ? ok("a host already bound to one org cannot be claimed by another")
        : bad("TWO ORGANISATIONS CLAIMED ONE HOST");

  for (const bogus of ["https://portal.example.com", "portal.example.com/login", "localhost"]) {
    const { error: e } = await op.rpc("set_org_domain", {
      p_org_id: oea.id, p_domain: bogus,
      p_reason: "Storing something that is not a bare hostname.",
    });
    e ? ok(`"${bogus}" is refused rather than stored and never matched`)
      : bad(`"${bogus}" WAS ACCEPTED AS A HOSTNAME`);
  }
  await op.auth.signOut();
}

console.log("\nD. Binding is audited");
{
  const { data } = await svc
    .from("operator_actions").select("action, reason, metadata")
    .eq("action", "set_org_domain").order("created_at", { ascending: false }).limit(1);
  const last = (data ?? [])[0];
  last ? ok("the bind is recorded in operator_actions") : bad("NO AUDIT ROW FOR set_org_domain");
  last?.metadata?.domain
    ? ok(`carrying the hostname it set (${last.metadata.domain})`)
    : bad("the audit row does not say which domain");
}

console.log("\nE. A retired organisation stops answering");
{
  const op = await login("platform@oegroup.test");
  await op.rpc("retire_org", {
    p_org_id: oea.id, p_reason: "Verifying a retired org releases its hostname.",
  });
  const { data } = await svc.rpc("org_branding_by_host", { p_host: HOST_O });
  (data ?? []).length === 0
    ? ok("a retired organisation's hostname resolves nothing")
    : bad("A RETIRED ORG STILL ANSWERS ON ITS HOST");
  await op.auth.signOut();
}

// ── Teardown: retire what this run created ─────────────────────────────────
// A retired org's hostname resolves nothing (section E), so retiring is the
// whole cleanup; nothing real was touched, so nothing needs restoring.
await operator.rpc("retire_org", {
  p_org_id: tfml.id, p_reason: "Retiring the probe org after the hostname verification.",
});
await operator.auth.signOut();
console.log("\n(probe orgs retired — no real organisation was touched)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a hostname paints a front door and decides nothing about access."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
