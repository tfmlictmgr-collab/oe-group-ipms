# Backup and restore

**Decided 20 Sept 2026** (build plan §2.5, closing gap F). This is the stated
backup posture for NDPA s.39 purposes, the procedure for taking a copy when you
want one, and the restore drill that makes the whole thing real rather than
believed.

> **A backup nobody has restored is not a backup. It is a belief.** Everything
> below is arranged around that one sentence — which is also why §4 is not
> optional.

---

## 1. The posture, and why it is this one

| Layer | Mechanism | RPO | Cost |
|---|---|---|---|
| **Baseline** | Supabase Pro **daily backups**, 7-day retention | ~24 hours | **included** |
| **On demand** | `npm run backup` — a verified `pg_dump` taken at a moment you choose | 0, at the moment taken | **$0** |
| *Considered and declined* | ~~Point-in-Time Recovery~~ | seconds | **$100/mo per project** |

### Why PITR was declined

Recorded so the decision is not silently re-litigated, and so it can be
**revisited on evidence** rather than on nerves.

1. **A day of ledger entries is reconstructible.** Paystack and Flutterwave hold
   their own transaction records, the bank statement holds every transfer, and
   an off-platform payment carries uploaded proof. Worst case is an afternoon of
   re-keying against a statement — unpleasant, not unrecoverable. **This is the
   load-bearing assumption and it has a shelf life:** it holds while volume is
   low. See §5 for the trigger to revisit.
2. **PITR covers Postgres only.** It would not protect a single identity
   document, payment proof or payout evidence file — all of which live in
   Storage, not in the database. The $100/month buys less than it appears to.
3. **$2,520/year across two projects** is real money for an organisation whose
   first client has not yet been onboarded.

Staging is explicitly **not** covered by any paid backup. It holds rehearsal
data that `npm run seed` recreates; paying to protect it would be paying to
protect something whose purpose is being disposable.

---

## 2. ⚠️ What is NOT backed up by any of this

Stated first and plainly, because every line in §1 is about **Postgres**, and
the most sensitive material in this system is not in Postgres.

| Not covered | What is in it |
|---|---|
| **Storage buckets** | identity documents (`application-documents`), photographs inside client homes (`work-order-media`), vendor KYC (`vendor-documents`), invoices (`invoice-attachments`), proof of payment (`payment-proofs`), payee bank evidence (`payout-evidence`) |
| **`auth` schema** | sign-in identities. `npm run backup` dumps `public` only |
| **Project configuration** | environment variables, edge functions, custom domains, and — critically — **`GATEWAY_CREDENTIAL_KEY`**, whose loss is unrecoverable by design (build plan §2.2) |

⛔ **OPEN, and it should not stay open past cutover: confirm directly with
Supabase whether the Pro daily backup includes Storage objects.** The database
is documented; Storage is not, and the honest position today is that *we do not
know*. If it does not, then the identity documents this system exists to
protect have **no backup at all**, which is a larger finding than anything PITR
would have addressed.

Until that is answered, do not describe this system as "backed up" without the
qualifier "the database is".

---

## 3. Taking a backup

```
node scripts/use-env.mjs <world>     # then READ BACK what it prints
npm run backup                       # writes into ./backups
npm run backup -- --out /Volumes/…   # or somewhere you choose
```

Requires PostgreSQL client tools (`pg_dump`, `pg_restore`) at least as new as
the server. The script says so, with install instructions, if they are missing.

**What it does that a "download" button would not:**

- refuses if `.env.local`'s two halves name different projects — a backup of the
  wrong world is worse than none, because you would keep it;
- **reads the archive back with `pg_restore --list` before reporting success**,
  and **deletes the file** if it cannot. A dump that is truncated — the way a
  timed-out export truncates — exits 0 and looks perfect. This is the specific
  failure this script exists to catch, and it is the reason the work is not a
  button in the product;
- writes a **manifest** beside the dump: schema version, byte size, SHA-256, and
  the row counts of twelve core tables taken *before* the dump, so a future
  restore is checked against something rather than eyeballed;
- records `operator.backup_taken` in the audit trail, so "when was the last
  backup?" is answerable from the system rather than from memory.

⚠️ **The file it writes contains every personal record in the system.** Treat it
as the database itself: encrypted disk, never a shared drive, never email,
deleted when the reason for taking it has passed. It is a processing record
under NDPA like any other copy. `backups/`, `*.dump` and `*.manifest.json` are
gitignored; that is a safety net, not permission to be casual.

**Take one before:** any migration against production, any bulk correction, any
data fix written by hand, and immediately before cutover.

---

## 4. Restoring — and the drill

### The drill (quarterly — build plan §7.6)

Restore into a **scratch database**, never over a live one. The point is to
prove the file is good and that you know the commands, not to change anything.

```
createdb ipms_restore_drill
pg_restore --no-owner --no-privileges -d ipms_restore_drill <file>.dump
```

Then check the restored database against the manifest:

```
psql -d ipms_restore_drill -c "select count(*) from payments"
```

Compare with `rowCounts` in the `.manifest.json`. **A restore that completes
but is missing half the payments is a failed backup**, and nothing except this
comparison would tell you.

📌 **One warning is expected and benign:**

```
pg_restore: error: could not execute query: ERROR:  schema "public" already exists
pg_restore: warning: errors ignored on restore: 1
```

The dump recreates the `public` schema, which the new database already has.
**Exactly one ignored error is normal. More than one is not** — read them. This
is written down so nobody learns to wave the number away.

### Restoring for real

1. **Stop writing to the target first.** A restore over a live database while
   the app is serving is how you get a half-old, half-new ledger.
2. Fix forward is still the default for *schema* problems — migrations are
   additive, so there is nothing to roll back. A restore is for **wrong data**,
   which is the case the deployment rollback never covered (gap G).
3. From a Supabase daily backup: dashboard → Database → Backups → restore. From
   an `npm run backup` file: the command in the manifest's `restoreWith`.
4. Afterwards, re-check `_migrations` — the restored schema version is in the
   manifest, and a restore that lands you on an older schema than the deployed
   build is its own incident.

---

## 5. When to revisit this decision

The posture above rests on "a day of transactions is re-keyable by a person".
Revisit **PITR on production** when any of these becomes true:

- a day's payments stop being something one person could reconstruct from bank
  statements in an afternoon;
- a second client organisation is onboarded, so a bad day affects people who did
  not choose this trade;
- Supabase confirms Storage **is** covered by PITR, which materially changes
  what the money buys;
- a restore drill (§4) fails, or the daily backup is found not to include
  something assumed.

Revisit **the Storage question in §2 before cutover, regardless.**

---

## 6. Where this is recorded

- `NDPA_COMPLIANCE_PACK.md` §8 — the stated s.39 measure and RPO.
- `GO_LIVE_BUILD_PLAN.md` §2.5 — the decision, §4.5 the rehearsal, §7.6 the
  quarterly drill.
- `GO_LIVE_CHECKLIST.md` §4 — rollback, which now points here for the database
  half.
