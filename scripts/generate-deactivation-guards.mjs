// The functions half of "deactivation is a rule, not a list of four names".
//
// 0194 fixed the four resolvers its author could think of. The live catalogue
// says 89 functions reference `auth.uid()`; 60 reach it through a resolver and
// 29 did not. This generator reads every body from `pg_get_functiondef` and
// rewrites it mechanically — 0183's rule, because a clause lost to a typo in
// `record_payment_approval` is a money bug.
//
//   npx tsx scripts/generate-deactivation-guards.mjs [<filename.sql>] [<headline>]
//
// Defaults to 0195_deactivation_is_a_rule_not_four_names.sql, the first run.
// Re-runnable: a function whose body already carries its edit is skipped, so
// pointing this at the catalogue again emits only what is genuinely new — pass
// the next migration's filename when it does.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import pg from "pg";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
config({ path: path.join(rootDir, ".env.local") });

const outName = process.argv[2] ?? "0195_deactivation_is_a_rule_not_four_names.sql";

// `@path` reads the headline from a file. A migration header carries the
// reasoning, and reasoning does not survive being squeezed through a shell
// argument — the first attempt at this one arrived as its opening line and
// nothing else.
const rawHeadline = process.argv[3] ?? "A guard that a null role walks straight past.";
const headline = rawHeadline.startsWith("@")
  ? readFileSync(path.resolve(rawHeadline.slice(1)), "utf8").trimEnd()
  : rawHeadline;

const client = new pg.Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  database: process.env.SUPABASE_DB_NAME,
  user: process.env.SUPABASE_DB_USER,
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// ── Group 1. `language sql`, keyed on auth.uid() ──────────────────────────
// Pure textual substitution of auth.uid() -> active_uid(). Nothing else in the
// body moves: the ORDER BY, the CASE arms and the column order that must match
// RETURNS TABLE all survive, which a hand-edited WHERE clause would not
// reliably do.
const SUBSTITUTE = [
  "my_requests", "my_tenancies", "my_rent_charges", "my_service_charges",
  "my_payment_history", "my_approval_limit", "my_channel_consents",
  "my_notifications", "vendor_user_can", "ticket_attachment_deletable",
];

// ── Group 2. `language plpgsql`, an action taken by a person ──────────────
// These get a stated refusal rather than an empty result, because a write that
// silently does nothing is the defect 0194 was written about.
const GUARD = [
  "record_payment_approval", "create_landlord_remittance",
  "raise_ops_requisition", "save_requisition_line_payee",
  "submit_vendor_registration", "offer_vendor_introduction",
  "update_my_profile", "update_my_notification_prefs",
  "record_my_channel_consent", "withdraw_my_channel_consent",
  "apply_reporter_urgency",
  // ⚠️ Added by 0197, found by verify-deactivation.mjs section E rather than by
  // reading. Its fm_pm branch is `if not (current_user_role() = any (...) or
  // ...) then raise`, which is NULL for a deactivated caller — so the IF never
  // fires and the guard is skipped entirely. The evaluation it lets through
  // feeds the KPI gate B4 puts in front of vendor payment.
  "submit_vendor_evaluation",
];

// ── Deliberately untouched, and why ───────────────────────────────────────
// Named here so the assertion at the foot of the migration allows exactly these
// and refuses anything else that appears later.
const EXEMPT = {
  accept_invitation:
    "creates the users row - a guard reading that row would refuse every new joiner",
  reject_payment:
    "not SECURITY DEFINER - runs under RLS as the caller, which already fails closed",
};

const GUARD_SQL = `  -- Deactivation guard. Null-safe by construction: current_user_is_active()
  -- returns a boolean from exists(), never NULL, and the auth.uid() test keeps
  -- the service role (scheduled jobs, webhooks) passing straight through.
  if auth.uid() is not null and not current_user_is_active() then
    raise exception 'this account has been deactivated';
  end if;
`;

const out = [];
const missing = [];

async function fetchDef(name) {
  const { rows } = await client.query(
    `select pg_get_functiondef(p.oid) as def, l.lanname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_language l on l.oid = p.prolang
      where n.nspname = 'public' and p.prokind = 'f' and p.proname = $1`,
    [name]
  );
  return rows;
}

// Re-runnable. A body that already carries its edit is skipped rather than
// edited twice — injecting the guard into a function that has it, or
// substituting an auth.uid() that is now an active_uid(), is how a generator
// stops being safe to point at the catalogue a second time.
const skipped = [];

for (const name of SUBSTITUTE) {
  const rows = await fetchDef(name);
  if (rows.length !== 1) { missing.push(`${name}: ${rows.length} matches, expected 1`); continue; }
  if (rows[0].lanname !== "sql") { missing.push(`${name}: is ${rows[0].lanname}, expected sql`); continue; }
  const def = rows[0].def;
  const hits = (def.match(/auth\.uid\(\)/g) || []).length;
  if (hits === 0 && def.includes("active_uid()")) { skipped.push(name); continue; }
  if (hits === 0) { missing.push(`${name}: calls neither auth.uid() nor active_uid()`); continue; }
  out.push(
    `-- ${name}: auth.uid() -> active_uid(), ${hits} occurrence(s).\n` +
    def.replaceAll("auth.uid()", "active_uid()") + ";\n"
  );
}

for (const name of GUARD) {
  const rows = await fetchDef(name);
  if (rows.length !== 1) { missing.push(`${name}: ${rows.length} matches, expected 1`); continue; }
  if (rows[0].lanname !== "plpgsql") { missing.push(`${name}: is ${rows[0].lanname}, expected plpgsql`); continue; }
  const def = rows[0].def;
  if (def.includes("this account has been deactivated")) { skipped.push(name); continue; }

  // The first line that is exactly `begin` is the function's own opening block:
  // everything before it is the signature and the DECLARE section, and no
  // nested block can precede it. Located rather than assumed — if the shape
  // ever changes, this refuses instead of injecting into the wrong place.
  const lines = def.split("\n");
  const at = lines.findIndex((l) => l.trim().toLowerCase() === "begin");
  if (at === -1) { missing.push(`${name}: no top-level 'begin' line to inject after`); continue; }
  lines.splice(at + 1, 0, GUARD_SQL);
  out.push(
    `-- ${name}: guard injected after the opening begin.\n` +
    lines.join("\n") + ";\n"
  );
}

// ── Group 3. resolve_chat_sender ──────────────────────────────────────────
// Keyed on a phone number rather than on auth.uid(), and reached service-role
// from the webhook, so neither of the shapes above fits. The edit is still
// mechanical: the clause is appended to every `u.org_id = p_org_id` line, which
// is the one predicate both the count and the fetch share. Retyping this body
// is exactly what 0183's rule forbids — it decides who a stranger on WhatsApp
// is taken to be.
const CHAT_ANCHOR = "where u.org_id = p_org_id";
{
  const rows = await fetchDef("resolve_chat_sender");
  if (rows.length !== 1) {
    missing.push(`resolve_chat_sender: ${rows.length} matches, expected 1`);
  } else {
    const def = rows[0].def;
    const hits = def.split(CHAT_ANCHOR).length - 1;
    // Two: the count that decides "exactly one, or nobody", and the fetch. One
    // would mean the body changed shape and the guard would land in half the
    // function.
    if (def.includes("u.deactivated_at is null")) {
      skipped.push("resolve_chat_sender");
    } else if (hits !== 2) {
      missing.push(`resolve_chat_sender: found ${hits} '${CHAT_ANCHOR}' anchors, expected 2`);
    } else {
      out.push(
        `-- resolve_chat_sender: deactivation clause appended to both org anchors.\n` +
        def.replaceAll(
          CHAT_ANCHOR,
          `${CHAT_ANCHOR}\n     and u.deactivated_at is null                       -- 0195`
        ) + ";\n"
      );
    }
  }
}

if (missing.length) {
  console.error("Refusing to write a partial migration:\n  " + missing.join("\n  "));
  await client.end();
  process.exit(1);
}

const exemptSql = Object.entries(EXEMPT)
  .map(([k, v]) => `      -- ${v}\n      '${k}'`)
  .join(",\n");

const header = `-- Deactivation is a rule, not a list of four names.
--
-- 0194 made \`deactivated_at\` mean something and proved it over four
-- resolvers. Reviewing it against the live catalogue rather than against its own
-- diff found the same defect twice more, in the same shape:
--
--     89 functions in \`public\` reference auth.uid()
--     60 reach it through current_user_org_id() / role() / property_ids() / vendor_ids()
--     29 held auth.uid() directly, and 0194 had touched none of them
--
-- ── What was actually open ────────────────────────────────────────────────
-- \`my_requests\`, \`my_tenancies\`, \`my_rent_charges\`, \`my_service_charges\`,
-- \`my_payment_history\`, \`my_approval_limit\` and \`my_channel_consents\` are all
-- SECURITY DEFINER, all granted to \`authenticated\`, and all gate on nothing but
-- \`<column> = auth.uid()\`. A deactivated tenant holding a live JWT reads every
-- one of them over /rest/v1/rpc directly. 0194's sign-out lives in
-- app/dashboard/layout.tsx, and no RPC has ever passed through a React layout.
--
-- \`raise_ops_requisition\` and \`save_requisition_line_payee\` are worse. Being
-- DEFINER they read \`select role, org_id from users where id = v_uid\` with RLS
-- off, so a deactivated ops staffer kept their role and could still raise a
-- requisition — a request for money.
--
-- \`resolve_chat_sender\` is the third shape. It is reached from the WhatsApp /
-- Telegram webhook through the SERVICE-ROLE client, so RLS never runs and none
-- of 0194's four resolvers are consulted. A deactivated person kept the primary
-- intake channel B8 gives them.
--
-- 📌 **This is 0185's lesson arriving a second time.** 0194 was written against
-- the four functions its author had in hand; 0185 already records that a
-- migration written against the diff rather than against the rule closes the
-- instances and leaves the class. So this one is generated from the catalogue
-- (\`scripts/generate-deactivation-guards.mjs\`) and ends by asserting the RULE —
-- anything reaching auth.uid() must reach it through a deactivation-aware path,
-- or be named with the reason it cannot.
--
-- ── One resolver, extended — again ────────────────────────────────────────
-- Decision 8 forbids a second scoping mechanism beside the first. \`active_uid()\`
-- is not one: it is the same extension applied one level lower. The functions
-- above do not ask "what may I reach", they ask "who am I" — and they asked
-- \`auth\`, which has no opinion about deactivation because deactivation is our
-- concept and not the auth provider's. \`active_uid()\` is that question answered
-- with our concept included, and the rewrite is a pure substitution so nothing
-- else in any body moves.
--
-- ⚠️ Generated, not typed. Every body below is \`pg_get_functiondef\` output with
-- one mechanical edit applied. Regenerate rather than hand-editing.
--
-- Verified by scripts/verify-deactivation.mjs.

-- ── Who am I, if I am still anyone ────────────────────────────────────────
-- NULL for a deactivated account, and NULL for an account with no profile row
-- at all — both of which make \`<column> = active_uid()\` match no row rather
-- than every row. It fails closed in the only direction it can fail.
create or replace function active_uid()
returns uuid language sql stable security definer set search_path = public as $$
  select u.id from users u where u.id = auth.uid() and u.deactivated_at is null;
$$;

revoke all on function active_uid() from public, anon;
grant execute on function active_uid() to authenticated, service_role;

comment on function active_uid is
  'auth.uid(), but NULL once the account is deactivated. For the functions that ask who the caller IS rather than what they may reach - the self-scoped my_* readers and the vendor/attachment predicates. Added by 0195, after 0194 fixed four resolvers and left twenty-nine direct callers.';

-- ── The bodies, rewritten from the catalogue ──────────────────────────────
`;

const footer = `
comment on function resolve_chat_sender is
  'Who is writing to us on WhatsApp or Telegram, by their phone number. A deactivated account resolves to nobody (0195) - this path runs service-role from the webhook, so RLS and the 0194 resolvers never see it, and without the clause here the primary intake channel stayed open to someone the organisation had removed.';

-- ── The notification feed ─────────────────────────────────────────────────
-- \`user_notifications_select\` was \`using (user_id = auth.uid())\`: no org gate
-- and no deactivation. It is also what \`my_notifications\` reads through — that
-- one being the single non-DEFINER function in the set — so the policy fixes
-- both.
drop policy if exists user_notifications_select on user_notifications;
create policy user_notifications_select on user_notifications for select
  using (user_id = active_uid());

comment on policy user_notifications_select on user_notifications is
  'Your own notifications, for as long as the account is live (0195).';

-- ── Prove the RULE, not the list ──────────────────────────────────────────
-- 0194's check named four functions and asserted a substring appeared in each.
-- It would have passed unchanged on the day every gap above was open, which is
-- exactly what its own header argues against: it proved the clause was PRESENT,
-- never that anything REFUSED.
--
-- This asks the catalogue instead. Every function in \`public\` that reaches
-- auth.uid() must either resolve identity through a deactivation-aware path, or
-- be named below with the reason it cannot. A function added later that does
-- neither fails the migration that introduces it.
do $$
declare
  v_bad text[] := '{}';
  r record;
begin
  for r in
    select p.proname, pg_get_functiondef(p.oid) as def,
           pg_get_function_result(p.oid) as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%auth.uid()%'
  loop
    -- A trigger cannot refuse a caller it was not called about: it fires on a
    -- row, and the write that reached it has already passed RLS. Guarding
    -- log_audit() would block the write it exists to record.
    continue when r.ret = 'trigger';

    continue when r.proname = any (array[
${exemptSql}
    ]);

    if r.def !~ '(deactivated_at\\s+is\\s+null|active_uid\\(\\)|current_user_is_active\\(\\)|current_user_org_id\\(\\)|current_user_role\\(\\)|current_user_property_ids\\(\\)|current_user_vendor_ids\\(\\))'
    then
      v_bad := v_bad || r.proname;
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception
      'These functions reach auth.uid() with no deactivation-aware path and are not declared exceptions: %',
      array_to_string(v_bad, ', ');
  end if;
end;
$$;
`;

// A follow-up run edits a handful of functions, not twenty-two, and shipping
// 0195's account of what was originally found alongside one guard would misread
// as a second discovery of the same thing. The rule, the exceptions and the
// assertion are re-stated either way — all of them are idempotent, and the
// assertion is the part most worth running again.
const isFirstRun = out.length > 5;
const compactHeader = `${headline.split("\n").map((l) => `-- ${l}`.trimEnd()).join("\n")}
--
-- A follow-up to 0195, which established the rule: everything in \`public\`
-- reaching auth.uid() must resolve identity through a deactivation-aware path,
-- or be a declared exception. See 0195's header for what that was written
-- about and why the bodies below are generated rather than typed.
--
-- ⚠️ Generated by scripts/generate-deactivation-guards.mjs from
-- \`pg_get_functiondef\`. Regenerate rather than hand-editing.

-- ── The bodies, rewritten from the catalogue ──────────────────────────────
`;

if (out.length === 0) {
  console.log("Nothing to write — every target already carries its edit.");
  console.log(`  skipped: ${skipped.join(", ")}`);
  await client.end();
  process.exit(0);
}

const sql = (isFirstRun ? header : compactHeader) + out.join("\n") + footer;
const target = path.join(rootDir, "supabase", "migrations", outName);
writeFileSync(target, sql, "utf8");
console.log(`Wrote ${path.relative(rootDir, target)}`);
console.log(`  ${out.length} function(s) rewritten from the catalogue`);
if (skipped.length) console.log(`  ${skipped.length} already carried the edit: ${skipped.join(", ")}`);
console.log(`  ${Object.keys(EXEMPT).length} declared exception(s)`);
await client.end();
