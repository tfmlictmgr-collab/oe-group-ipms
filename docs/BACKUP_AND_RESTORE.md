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
| **Off-site copy** | `npm run backup -- --encrypt` — the same, as ciphertext, safe to store anywhere (§3a) | as above | **$0** |
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

### ⛔ ANSWERED, 21 Sept 2026 — and the answer is the bad one

Confirmed with Supabase: **the daily backup covers the database only. Storage
objects are not in it.**

So the conditional written here before cutover is no longer a conditional. As
of today the identity documents, the photographs taken inside client homes, the
vendor KYC packs, the proofs of payment and the payee bank evidence have **no
backup of any kind** — not daily, not PITR, not the `npm run backup` dump,
which excludes them by design and says so in its own output.

📌 This is worth stating without softening, because it inverts the shape of the
risk everyone had in mind. The PITR conversation was about losing *a day* of
ledger rows — recoverable from gateway and bank records, which is exactly why
declining it was sound. This is about losing **everything, permanently**, in
the one category that cannot be reconstructed from anyone else's records. A
tenancy application's identity document exists in two places: the applicant's
own files, and here. Ask 400 tenants to re-upload proof of identity after an
incident and you have neither a functioning system nor a defensible NDPA
position.

It also makes a database restore actively misleading rather than merely
partial: the rows survive, every one of them carrying a storage path, and every
one of those paths resolves to nothing. The system would come back up looking
healthy.

**Consequence for the wording elsewhere:** nothing in this repository may
describe the system as "backed up" without the qualifier *"the database is"*,
and §1's stated RPO of ~24h is a **database** RPO. There is no storage RPO
because there is no storage backup.

**Closed 23 Sept 2026 by `npm run backup:storage`** — see §3b. The gap was
real for as long as it stood, and the fix is a script somebody has to RUN, so
it is only closed while the schedule in §3b is kept. Supabase's daily backup
still does not cover Storage and never will; what changed is that something
else does.

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

## 3a. A redundant copy somewhere else — and what makes it safe

**Asked 20 Sept 2026: can the database be replicated to Google Workspace, or
similar, at no cost?** Three separate answers, because the question contains
three different things.

### A live replica is not available free, and would reopen 1.7

A continuously-synced standby is a Supabase **read replica** (a paid add-on) or
a Postgres server you run yourself somewhere. Google Workspace cannot be that
somewhere — Drive stores files, it does not run Postgres, and there is nothing
to "connect" a database to. A free VM tier elsewhere could, but it would be a
new hosting location for the entire dataset, which **reopens `1.7`** — the
cross-border basis and the eu-west-1 / dub1 decision the board has already
taken and legal is already filing against. That is a large cost with no dollar
sign on it.

### A redundant *copy* is free, and is worth having

This is the useful version of the idea, and `npm run backup --encrypt` is built
for it. What makes a second copy safe is not where it goes — it is that it is
**ciphertext before it leaves this machine**.

```
npm run backup -- --encrypt          # AES-256-GCM, passphrase-derived key
npm run backup -- --decrypt <file>   # to get it back
```

The script encrypts **after** `pg_restore --list` has verified the dump, then
**decrypts it straight back and compares it byte for byte** before deleting the
plaintext. An encrypted backup nobody has decrypted is precisely the belief
this whole document refuses, and a mistyped passphrase is otherwise silent
until the day the file is needed. If the round-trip fails, nothing encrypted is
kept and the plaintext is left where it was.

Once the file is ciphertext, the destination stops being a data-protection
question and becomes a durability one. Google Drive, OneDrive, an external
disk, a second office — all fine. Two copies in two places is the actual goal.

⚠️ **Google is already a processor on the DPA tracker** (for Gemini failover,
under the Google Cloud DPA, which also covers Workspace). That makes Drive a
smaller step than a brand-new vendor — but note that **Workspace data regions
are an Enterprise feature**, so on a Business tier you do not control where the
file physically sits. With an encrypted file this matters much less; with an
unencrypted one it would matter a great deal. Do not put an unencrypted dump in
Drive.

⚠️ **This adds a second unrecoverable secret.** The backup passphrase is as
final as `GATEWAY_CREDENTIAL_KEY`: lose it and the copies are random bytes.
Escrow it the same way — sealed, two holders, named in the runbook — and
**never in the same envelope as the drive that holds the backups**, or one
theft takes both. `BACKUP_PASSPHRASE` may be set in the environment for an
unattended run; prefer the interactive prompt, which never touches shell
history.

### What a copy still does not cover

Everything in §2. A second copy of the database is still only the database —
the storage buckets are not in it, and the **Storage question in §2 remains
open**. Redundancy multiplies what you already have; it does not add what is
missing.

**Proven 20 Sept 2026** against PostgreSQL 16: an encrypted backup taken and
round-trip-verified; a **wrong passphrase refused**; a **single flipped byte
refused** (GCM authenticates, so an altered file fails rather than decrypting
into quiet nonsense); and the correct passphrase decrypting to a file whose
SHA-256 matches the manifest, restored into a fresh database with matching row
counts.

---

## 3b. Backing up the STORAGE buckets too — the gap §2 now names

**Asked 21 Sept 2026, twice: can data *and* storage objects both be copied to
Google Workspace at no cost?** Yes. The transport is free and the hard part is
not the transport.

### ✅ Built 23 Sept 2026 — `npm run backup:storage`

```
npm run backup:storage                      # into ./backups
npm run backup:storage -- --encrypt         # AES-256-GCM before it leaves
npm run backup:storage -- --decrypt <file>  # read one back
```

**Why it had to be new code.** `pg_dump` dumps a database, and the bytes are
not in the database. Postgres holds `storage.objects` — metadata and paths —
while the objects live behind the Storage API. `npm run backup` says so in its
own output rather than implying otherwise.

**What it produces.** An ordinary `tar`: `manifest.json` plus
`objects/<bucket>/<path>`, optionally wrapped in the same AES-256-GCM
envelope the database backup uses. Deliberately a tar rather than a private
container — a backup can outlive the script that wrote it, and `tar -xf` needs
no part of this repository.

**How it refuses to lie to you**, which is the whole point:

* It enumerates from **`storage.objects`**, not from the Storage API's
  `list()`. A listing paginates per folder and must be walked recursively, so
  completeness would depend on getting that traversal right — and the failure
  mode of getting it wrong is a smaller archive that reports success. It also
  gives the reconciliation something independent to check against; a listing
  cannot disagree with itself.
* **One object it cannot fetch fails the whole run**, and the staging
  directory is deleted. A partial archive is worse than none, because it stops
  anyone looking for one.
* It **reads the tar back** with `tar -tf` and checks every manifest entry is
  present before reporting success — the sibling script's `pg_restore --list`
  rule in a different format.
* With `--encrypt` it **decrypts straight back and compares** before deleting
  the plaintext. An encrypted backup nobody has decrypted is precisely the
  belief this document refuses, and a mistyped passphrase is otherwise silent
  until the day the file is needed.
* It refuses to run when the two halves of `.env.local` name different
  projects — the same relational check `migrate.mjs` makes, for the same
  6 Aug 2026 reason. Listing one world's files while downloading another's
  would produce an archive that is neither.

**What it does NOT do, said plainly:** the read-back proves the archive is
structurally intact and complete by name. It does not re-hash every object —
that would mean extracting the whole archive a second time. The per-object
SHA-256 is in the manifest, and that is what a restore checks each file
against.

**Shared format.** `scripts/lib/backup-crypto.mjs` holds the one
implementation, imported by both backup scripts. Two copies of a file format
diverge silently, and you find out when a backup taken by one cannot be read
by the other — at the moment you are trying to read it.
`verify-backup-crypto.mjs` proves the round trip on 3 MiB of real bytes and
that a wrong passphrase, a single flipped byte, a truncated file and a foreign
file are each refused.

### Getting it to Google Workspace — no API work, no cost

Do **not** build a Drive API integration for this. Install **Google Drive for
desktop** on the operator machine and have the backup script write into a
synced folder. Drive uploads it. That is the whole mechanism: no OAuth client,
no service account, no credential to rotate, no code that can silently stop
working, and it uses Workspace storage already being paid for.

Versioning comes free with it — Drive keeps prior versions, so a corrupted
backup that syncs does not overwrite the last good one. Set the folder to
**mirror**, not stream, so the files exist locally as well; a "backup" that
only exists in the cloud is one outage away from being no backup.

### ⚠️ The condition that is not optional

**Only encrypted archives leave this machine.** Unencrypted identity documents
and payment evidence synced to Drive would be a transfer of personal data to a
third party and a new processing location — the same `1.7` question §3a
declines to reopen, and a far worse instance of it than a database dump,
because this material *is* the sensitive category. Ciphertext with a key Google
never holds is not that transfer.

Which makes **K2 escrow load-bearing here, not administrative**: the passphrase
must not live only in Drive, only on the machine that writes the backups, or
only in one person's head. Records of processing should note Google as holding
encrypted copies even so.

### What this still will not cover

`GATEWAY_CREDENTIAL_KEY` and the `auth` schema — see §2. Neither is in a
bucket, and neither becomes covered by any of the above.

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
