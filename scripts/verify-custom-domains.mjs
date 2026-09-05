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

const { data: orgs } = await svc
  .from("orgs").select("id, name, slug, custom_domain").is("deleted_at", null);
const tfml = orgs.find((o) => o.slug === "tfml");
const oea = orgs.find((o) => o.slug === "oea");

// Remember what was there, and put it back at the end.
const original = { tfml: tfml.custom_domain, oea: oea.custom_domain };
const HOST_T = "probe-portal.tfmlconsultant.test";
const HOST_O = "probe-portal.oraegbunike.test";

console.log("Hostnames resolve one organisation, and grant nothing\n");

console.log("A. Only an operator may bind a domain");
{
  const brand = await login("tfml.admin@oegroup.test");
  if (!brand) bad("could not sign in as the TFML administrator");
  else {
    const { error } = await brand.rpc("set_org_domain", {
      p_org_id: tfml.id, p_domain: HOST_T,
      p_reason: "A tenant claiming its own hostname.",
    });
    error ? ok("a brand administrator cannot bind a domain, even to their own org")
          : bad("A TENANT ADMIN CLAIMED A HOSTNAME");

    // Nor by writing the column directly — 0083c's allowlist must not include it.
    const { data: patched } = await brand
      .from("orgs").update({ custom_domain: HOST_T }).eq("id", tfml.id).select("id");
    (patched ?? []).length === 0
      ? ok("nor write the column directly")
      : bad("A TENANT ADMIN PATCHED custom_domain");
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
  t.length === 1 && t[0].slug === "tfml"
    ? ok("the TFML host resolves TFML, one row")
    : bad(`the TFML host returned ${t.length} row(s)`);

  const o = await one(HOST_O);
  o.length === 1 && o[0].slug === "oea"
    ? ok("the OEA host resolves OEA, one row")
    : bad(`the OEA host returned ${o.length} row(s)`);

  (await one("nothing-here.example.test")).length === 0
    ? ok("an unknown host resolves nothing — hostnames cannot be enumerated")
    : bad("AN UNKNOWN HOST RESOLVED AN ORGANISATION");

  // Wildcards and quotes must match literally, not pattern-match.
  for (const probe of ["%", "%.test", "' or '1'='1", "_robe-portal.tfmlconsultant.test"]) {
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
  error ? ok("a host already bound to TFML cannot be claimed by OEA")
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
  await op.rpc("unretire_org", {
    p_org_id: oea.id, p_reason: "Restoring after the hostname verification.",
  });
  await op.auth.signOut();
}

// ── Restore ────────────────────────────────────────────────────────────────
await svc.from("orgs").update({ custom_domain: original.tfml }).eq("id", tfml.id);
await svc.from("orgs").update({ custom_domain: original.oea }).eq("id", oea.id);
console.log("\n(restored original domains)");

console.log(
  failures === 0
    ? "\n\x1b[32mALL CHECKS PASSED\x1b[0m — a hostname paints a front door and decides nothing about access."
    : `\n\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
