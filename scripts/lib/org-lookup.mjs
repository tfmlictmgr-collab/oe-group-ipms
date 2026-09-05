// Finding the org a brand belongs to, without guessing.
//
// ⚠️ `delivery_brand` is NOT a unique key, and this build has now been bitten by
// treating it as one three separate times:
//
//   1. **0085** — org slugs were derived from `delivery_brand`, and two OEA orgs
//      collided. Slugs moved to being derived from the name.
//   2. **The 360dialog migration** — `register-whatsapp-number.mjs` looked up an
//      org with `eq("delivery_brand", brand).limit(1)`, no ordering and no
//      `deleted_at` filter. A leftover probe fixture, `PROBEOP-Brand-7I1EB`,
//      shared `delivery_brand = 'OEA'` with the real org, and Postgres handed
//      back the probe. **A live WhatsApp API key was attached to an org nobody
//      uses**, while the real org's route sat untouched.
//   3. **`register-telegram-bot.mjs`** — same shape, and worse in one respect:
//      it used `.maybeSingle()` and destructured only `data`, so on TWO matches
//      PostgREST returns an error and null data, and the script printed *"No
//      organisation with delivery_brand X"* — announcing that none exists at the
//      exact moment several do.
//
// `'direct'` is the worst case and is live today: the POC, the SC client and the
// platform operator all carry it, so "the direct org" has never been a thing.
//
// The rule this encodes: **refuse and list, never pick.** A script that attaches
// a credential must stop and make a person choose, because the failure mode of
// guessing is silent and the failure mode of refusing is a message on a terminal.

/**
 * The single LIVE org for a delivery brand.
 *
 * Returns `{ org }` or `{ error, candidates }` — never a guess. Callers print
 * the candidates and exit; nothing here calls `process.exit` itself, so this
 * stays usable from a suite as well as a script.
 */
export async function liveOrgForBrand(svc, brand) {
  const { data: candidates, error } = await svc
    .from("orgs")
    .select("id, name, portal_name, slug, delivery_brand, is_platform_operator, created_at")
    .eq("delivery_brand", brand)
    .is("deleted_at", null);          // a retired fixture is not a candidate

  if (error) {
    return { error: `could not read the organisation list — ${error.message}`, candidates: [] };
  }
  if (!candidates?.length) {
    return { error: `No live organisation has delivery_brand "${brand}".`, candidates: [] };
  }
  if (candidates.length > 1) {
    return {
      error:
        `Ambiguous: ${candidates.length} live organisations share delivery_brand "${brand}". ` +
        "Refusing to guess which one this belongs to.",
      candidates,
    };
  }
  return { org: candidates[0], candidates };
}

/**
 * The script-shaped wrapper: resolve or die, having said exactly why.
 *
 * Prints the candidate table on ambiguity so the operator can retire the stray
 * one rather than being told only that something is wrong.
 */
export async function requireOrgForBrand(svc, brand) {
  const { org, error, candidates } = await liveOrgForBrand(svc, brand);
  if (org) return org;

  console.error(`\n${error}\n`);
  if (candidates.length > 1) {
    console.table(
      candidates.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.portal_name || c.name,
        operator: c.is_platform_operator ? "yes" : "",
        created: c.created_at,
      }))
    );
    console.error(
      "\nEither retire the stray organisation(s) — the operator launcher, or\n" +
      "`update orgs set deleted_at = now() where id = '<id>'` — or pass the org\n" +
      "by slug if this script supports it. Nothing has been written.\n"
    );
  }
  process.exit(1);
}

/**
 * The same guard for a SLUG, which genuinely is unique among live orgs (0085).
 *
 * Offered beside the brand lookup on purpose: a caller reaching for
 * `liveOrgForBrand('direct')` almost always wants one specific org and should be
 * using this instead.
 */
export async function liveOrgBySlug(svc, slug) {
  const { data, error } = await svc
    .from("orgs")
    .select("id, name, portal_name, slug, delivery_brand, is_platform_operator")
    .eq("slug", slug)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return { error: `could not read the organisation — ${error.message}` };
  if (!data) return { error: `No live organisation has the slug "${slug}".` };
  return { org: data };
}

/**
 * A seeded fixture account, found by ROLE rather than by a spelling of its email.
 *
 * ⚠️ Why this exists. Four suites resolved OEA's landlord as
 * `oea.propertyowner@oegroup.test` and then used `landlord.id` on the next
 * line. `seed-brand-roles.mjs` seeds the brand portals with the shorter
 * `oea.owner@oegroup.test`, while `seed.mjs` uses `<slug>.propertyowner@` — so
 * on any world seeded by the former, all four crashed with
 * `Cannot read properties of null (reading 'id')` before reaching a single
 * assertion. A red suite that never states a claim is worse than a failing one:
 * it looks like the code under test is broken when the fixture is.
 *
 * The role is the durable fact; the email is a seeding convention that has
 * legitimately changed twice. Hints are tried first so an intentionally
 * specific account still wins, then the role within the org.
 */
export async function fixtureUser(svc, orgId, role, hints = []) {
  for (const email of hints) {
    const { data } = await svc.from("users")
      .select("id, email, role").eq("email", email).maybeSingle();
    if (data) return data;
  }
  const { data, error } = await svc.from("users")
    .select("id, email, role")
    .eq("org_id", orgId).eq("role", role).is("deactivated_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`could not read users for ${role} — ${error.message}`);
  if (!data?.length) {
    throw new Error(
      `No live "${role}" exists in org ${orgId}.\n` +
      `  Tried: ${hints.join(", ") || "(no email hints)"}\n` +
      `  Seed one with: node scripts/seed-brand-roles.mjs`
    );
  }
  return data[0];
}
