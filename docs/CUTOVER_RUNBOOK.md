# TENTai — Production runbook

**Build plan 4.2.** Written 26 September 2026 **from the real cutover**
(Stage 3, 21 Sept; Stage 5, 24–25 Sept 2026), not from a rehearsal on staging.
The plan asked for the rehearsal first. It was overtaken: production was built
for real before staging was rehearsed. This runbook is therefore what was
actually done, in the order that worked, with each trap written in where it was
hit.

⚠️ **About the times.** The cutover was not run against a clock. A time marked
**measured** was measured. A time marked **est.** is an estimate from the
records, not a measurement. The next person to run a section should replace the
estimates with measured times.

It covers three jobs:

| Part | When you need it | How often |
|---|---|---|
| **1. Release** | shipping a new release candidate to production | every release |
| **2. Rebuild from empty** | standing production up in a new Supabase project (disaster, region move) | hopefully never |
| **3. Roll back** | a release is bad (application) or data is wrong (database) | incident |

Each step's evidence goes in `docs/verify-runs/`. **A step with no evidence
committed has not happened.**

---

## 0. Rules for every step

1. **Two people.** One types; one reads the step aloud and checks the result
   against this page. Check after each step; never do several before checking.
2. **Confirm the target before every command that writes.**
   `node scripts/use-env.mjs prod`, then read the printed project ref aloud:
   production is **`civwriqvghvyqtfrzftu`**. In the SQL editor, read the ref
   in the address bar. On 25 Sept the read-back was first run in the wrong
   editor; what gave it away was about 100 `PROBE…` orgs.
3. **Read the header line of any `vercel` command before believing its body.**
   `vercel env ls production` once answered confidently about the staging
   project because it resolved the project from the git remote.
4. **Check content, not status codes.** Always use `curl -sSL` (the apex
   redirects 308 to `www`), and look for a string that exists only in the new
   build. On 20 Aug, four deploys served an 18-day-old build while every host
   answered 200.
5. **Production is never seeded.** No seeder, no `verify-*` suite and no
   `verify-all` run ever targets production. `verify-all` refuses production,
   and so do the suites that create records.
6. **Secrets are generated at the destination and never pasted into chat.**
   Enter tokens with `read -rs` and run `history -c` afterwards. Losing
   `GATEWAY_CREDENTIAL_KEY` or the backup passphrase cannot be recovered from.
7. **Merging to `main` is deploying.** Vercel builds `main` to production
   automatically (5.2). Nothing reaches `main` that you would not ship.

---

## Part 1 — Release a new candidate

This is the path rc6 and rc7 took. Est. **2–3 h**, most of it the verify run.

| # | Step | Command / where | Pass when | Time |
|---|---|---|---|---|
| 1.1 | Build the candidate tree | `npm ci`, `npm run build` | tsc clean, 0 lint errors, 85/85 pages | est. 10 min |
| 1.2 | Full verify against **staging** | `node scripts/use-env.mjs staging`, then `npm run dev` in a second window, then `node scripts/verify-all.mjs` | 129/129 (grep `FAIL` with no trailing space). No "LEFT REAL ORG SETTINGS CHANGED" | est. 60–90 min |
| 1.3 | Record it | `docs/verify-runs/rcN-YYYYMMDD.md` + tag message | committed | 15 min |
| 1.4 | **Back up production** before any migration | `node scripts/use-env.mjs prod` → read ref → `npm run backup` | "Backup verified", **two files**: `<name>.dump` and `<name>.auth.dump.enc` (sign-in accounts, always encrypted; asks for the escrowed passphrase). The main dump is **plaintext** unless you add `-- --encrypt` | measured ~2 min, 26 Sept |
| 1.5 | Apply new migrations to production **before** merging | same window: `npm run migrate` | ledger count = number of files in `supabase/migrations` (323 at rc7, highest `0302`) | est. 2 min |
| 1.6 | Merge the PR | GitHub | Vercel shows the production deployment "Ready" | est. 3–5 min |
| 1.7 | Prove the new build is serving, on content | `curl -sSL https://www.tfmlportal.com/<page> \| grep -c "<new string>"` | prints ≥ 1 | 1 min |
| 1.8 | Prove every host serves the same build | the three `dpl_` commands below | all three print the same id | 1 min |
| 1.9 | Post-merge suites | only the suites that read files changed since 1.2, against staging | all pass | est. 10 min |
| 1.10 | Tag the **merge commit** and push the tag | `git tag -a v1.0.0-rcN -F docs/verify-runs/rcN-tag-message.txt <sha>` then `git push origin v1.0.0-rcN` | GitHub shows the tag → that sha | 2 min |

```
curl -sSL https://www.tfmlportal.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
curl -sSL https://oeaportal.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
curl -sSL https://portal.tfmlconsultant.com/login | grep -o 'dpl_[A-Za-z0-9]*' | head -1
```

**Why migrations go before the merge (1.5 before 1.6):** migrations are
additive, so the old build runs happily on the new schema. The new build on the
old schema does not. Migrate first, and the merge can never catch the database
behind.

**Rule 7 (the tag rule):** a fix inside `next build` after the tag is cut means
that tag is not what production runs. Cut a new candidate and re-run 1.2. A
docs-only change does not need one.

### Changing an environment variable

Setting a variable in Vercel **does not apply it**. The deployment snapshots
variables when it is built. On 24 Sept `DPO_CONTACT_EMAIL` was set and the
privacy notice quietly fell back to the org's support address, which looked
entirely correct.

1. Set it, scoped to **Production**, and read the header to check which project you are in.
2. Redeploy the current production deployment.
3. Read the value back **off the live page**, not off the dashboard.

---

## Part 2 — Rebuild production from empty

The order that worked, 21–25 Sept 2026. Plan references are in brackets.

### 2A. The database (Stage 3) — 21 Sept

| # | Step | Pass when | Trap hit on the day |
|---|---|---|---|
| A1 | Create the Supabase project in **eu-west-1**; record the ref [3.1] | ref written in the plan | — |
| A2 | Write `.env.prod.local` **on the operator's machine**; `node scripts/use-env.mjs prod` | the banner shows the new ref, not `(unreadable)` | An unparseable file once printed the red PRODUCTION banner over `project : (unreadable)`. `use-env` now refuses it. |
| A3 | `node scripts/check-db-connection.mjs --world prod` | port 5432 **and** 6543 both accept | `28P01` on 5432 was a stale pooler cache after two quick password resets, not a wrong password. It cleared in ~15 min, **measured**. Diagnose with this script; don't re-run the migrator on a guess. |
| A4 | `npm run migrate` — **schema only, no seed** [3.3] | ledger count = file count; highest = newest file | `0214`'s guard refused a fresh build until `0213a` existed. A guard that fails is working. |
| A5 | Run `docs/sql/stage3-production-proof.sql` [3.4, 3.6] | 7 buckets OK; every personal/money/work table at 0; privilege audit shows none of the `0213a` functions | `orgs = 2` (`oe-group`, `sc-client`) is correct, not leftovers |
| A6 | Record: `docs/verify-runs/stage3-YYYYMMDD-production-proof.md` | committed | — |

### 2B. The application (Stage 5) — 24 Sept

| # | Step | Pass when | Trap hit on the day |
|---|---|---|---|
| B1 | Vercel project **`tent-ai-production`**, linked from the operator's checkout. Back up `.vercel/project.json` | the project id in the file = the dashboard's | The CLI resolves projects from the git remote. Read headers. |
| B2 | Set every production variable [3.5], then **redeploy** | values read back off live pages | See "Changing an environment variable". Payment-gateway keys stay **unset** until Flutterwave: the collections screen then reads "No payment account connected", which is correct. |
| B3 | Merge the release to `main` [5.2] | deployment Ready | This **is** the deploy; nobody schedules it |
| B4 | `node scripts/bootstrap-production.mjs --confirm civwriqvghvyqtfrzftu --email <operator email>` [5.4] | one-time link delivered; password changed at first sign-in; **MFA enabled before anything else** | Never reach for a seeder here: `seed.mjs` truncates `orgs` and would delete `oe-group` and `sc-client`. Use `--reissue-link` if the link expires. |
| B5 | Create TFML and OEA in the operator portal (**Orgs → Create**); invite each org's administrator | both orgs listed; invitations pending | — |
| B6 | **Move** the three domains into `tent-ai-production`: Settings → Domains → Add → **move** [5.7] | `vercel domains inspect` names `tent-ai-production` | **Move, never `vercel alias set`.** An alias pins a host to one old deployment forever (the 20 Aug incident). DNS stays on Namecheap (CNAME); ignore Vercel's ☓ about its own nameservers and its warning about the apex `tfmlconsultant.com`. |
| B7 | Bind each org's `custom_domain` in the operator portal [5.8] | the read-back (B12) shows each domain | Unbound, every link falls back to the `*.vercel.app` host, which is nobody's portal (B1) |
| B8 | Check the `dpl_` ids match on all three hosts [5.9] | same id ×3 | — |
| B9 | **Telegram** [5.6]: revoke each token in BotFather, then `node scripts/register-telegram-bot.mjs TFML "$TOKEN"` (token entered with `read -rs TOKEN`), and the same for OEA. Remove `TELEGRAM_BOT_TOKEN` from Vercel and redeploy | the script reads the webhook back from Telegram | An exposed token must be revoked. Revoking keeps the bot and its @username. The webhook host `tent-ai-production.vercel.app` is correct: it is machine-to-machine. |
| B10 | **WhatsApp** [5.5]: regenerate each 360dialog API key; mint one token per number (`openssl rand -hex 24`), run `node scripts/register-whatsapp-number.mjs TFML <token> <api-key> "<label>"` and the same for OEA, **then paste** `…/api/webhooks/whatsapp?token=<token>` into the 360dialog Hub | a live message routes to the right org and is answered from its own number | Two halves: the script, **and** the Hub paste, which has no API. A number has one webhook, so it answers one world. Neutralise staging's and dev's routes afterwards with a new random `external_id` and a unique placeholder key (`staging-placeholder-no-send-…`), **never NULL**, or `verify-gateway-isolation` fails. |
| B11 | Record each org's **client-funds bank account** (Settings → Banking) [1.9] | read-back query 3 OK | With none, `client_funds_bank_account()` raises and the offline money path cannot run at all. `record_opening_balance` refuses zero; leave a new, empty account with no opening entry. |
| B12 | `docs/sql/stage5-readback.sql` in the production editor [5.10] | TFML and OEA OK in all three queries | `sc-client` STOP (no sender) is the dormant placeholder, by decision |
| B13 | Each host names only itself (B1) [5.10] | 0 cross-brand hits across the 6 pages | Command below |
| B14 | One real message to each of the 4 channels; count them in `chat_webhook_events` | 4 rows, right org each | A greeting opens no request, by design |
| B15 | Turnstile: code first, **then** Supabase → Auth → Attack Protection → CAPTCHA (Turnstile) on, **production only** | sign-in works on both portals with the widget | Switching CAPTCHA on before the code is live locks everyone out, the operator included. Staging and dev keep it off (77 suites sign in with passwords). |
| B16 | Live updates: migrations `0301` and `0302` present; `node scripts/diagnose-realtime.mjs --world prod` while inserting a notification | the listener hears the change; the bell updates without a reload | "Live" on screen proved nothing on 25 Sept: one unsigned subscriber silenced the stream for everyone |
| B17 | Re-run the emptiness query and record it | only provisioning rows | Emptiness is the one claim that decays silently |

```
for h in www.tfmlportal.com oeaportal.com; do for p in terms refunds privacy; do
  echo "$h/$p: $(curl -sSL https://$h/legal/$p | grep -oE 'Total Facilities Management|Ora Egbunike|TFML|OEA' | sort | uniq -c | tr '\n' ' ')"
done; done
```

Evidence from the real run: `stage3-20260921-production-proof.md`,
`stage5-20260924-production-proof.md`, `stage5-20260925-readback.md`.

---

## Part 3 — Roll back

### 3A. A bad release (application)

**Measured 24 Sept: under 10 seconds**, click to content change
(`rollback-drill-20260924.md`).

1. Vercel → `tent-ai-production` → Deployments → the last good deployment →
   **Instant Rollback**.
2. Prove it **on content**: fetch a page whose content differs between the two
   builds. A 404 for a route the old build lacks cannot be faked by a cache;
   a 200 can.
3. Fix on a branch, run Part 1, and **Promote** forward.

⚠️ **If a variable was added after a deployment was built, promote its
redeploy, not the original.** Two builds of `5f5512a` existed; only the redeploy
could see `DPO_CONTACT_EMAIL`. Read the value back off the page to tell them
apart.

⚠️ Instant Rollback changes the application only. **Migrations are not undone.**
That is safe because they are additive. The schema is fixed forward.

### 3B. Wrong data (database)

A deployment rollback does not touch data. For wrong data:

1. **Stop writing first.** Roll back or pause the app. A restore under a live
   app gives a half-old, half-new ledger.
2. Restore from Supabase's daily backup (Database → Backups), or from an
   `npm run backup` file using the manifest's `restoreWith`.
   `BACKUP_AND_RESTORE.md` §4, "Restoring for real".
3. Re-check `_migrations` against the deployed build.

⚠️ **Drilled on a real production dump 26 Sept 2026, and it found a gap.**
Every row and constraint came back except the three foreign keys into
`auth.users`. The backup did not carry the sign-in accounts, so a restore into
a new project would have let nobody log in
(`docs/verify-runs/restore-drill-20260926.md`). Fixed the same day: the backup
now writes a second, always-encrypted archive of the accounts, proven locally
against Supabase's real `auth` schema. **Re-run the drill with a new backup to
close 4.5.** The new-Supabase-project restore path is proven on plain
PostgreSQL only.

---

## Where each fact came from

| Section | Record |
|---|---|
| 2A | `docs/verify-runs/stage3-20260921-production-proof.md`; plan 3.1–3.3 |
| 2B | `docs/verify-runs/stage5-20260924-production-proof.md`, `stage5-20260925-readback.md`; plan 5.2–5.10, 1.9, 2.8 |
| 3A | `docs/verify-runs/rollback-drill-20260924.md` |
| 3B | `docs/BACKUP_AND_RESTORE.md` §4 |
| Part 1 | `docs/verify-runs/rc6-20260925.md`, `rc7-20260925.md` |
