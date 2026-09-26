# 4.5: restore drill on a real production dump, 26 September 2026

**Backup:** `production-civwriqvghvyqtfrzftu-2026-09-26T08-29-23.dump`, taken
with `npm run backup` from `civwriqvghvyqtfrzftu` (Postgres 17.6) with
`pg_dump` 17.11. 1.4 MB, 80 tables of data, `pg_restore --list` read-back OK,
recorded as `operator.backup_taken`. sha256 `e89d172f…3004b4ae`. The first
database backup of production.
**Target:** a throwaway `postgres:17` container on the operator's machine.
**Procedure:** `BACKUP_AND_RESTORE.md` §4 as it stood that morning: prep, then
`pg_restore --no-owner --no-privileges`, then `restore-drill-check.sql`.

## Result: every row and constraint restored except the three into `auth.users`

| | manifest (production) | restored |
|---|---|---|
| schema / migrations | `0302…` / 323 | `0302…` / 323 |
| foreign | 271 | **268** |
| check / primary / unique / trigger | 146 / 80 / 25 / 4 | identical |
| exclusion (`leases_no_overlap`, the double-let guard) | 1 | 1, **PRESENT** |
| rows: orgs, users, tickets, audit_log | 4, 3, 1, 290 | identical |
| rows: the other 8 counted tables | 0 | 0 |

`pg_restore` reported **4** errors: the expected `schema "public" already
exists`, and three it had never shown before:

```
mfa_backup_codes_user_id_fkey  → auth.users   Key (user_id)=(fa4de5e1-…) is not present
password_resets_user_id_fkey   → auth.users   Key (user_id)=(fa4de5e1-…) is not present
users_id_fkey                  → auth.users   Key (id)=(fa4de5e1-…) is not present
```

## ⚠️ Finding: the backup did not contain anyone who could sign in

`npm run backup` dumped `--schema=public` only. The sign-in accounts (email,
password hash, MFA factors) live in Supabase's `auth` schema, so they were
never in the file. The prep's stub `auth.users` was empty, and the three
foreign keys that point into it refused.

- **Restored into the same project** (the wrong-data case): no harm. The
  project's own accounts are still there and the keys reconnect.
- **Restored into a new project** (the lost-account case, which is the only
  reason an off-platform copy exists): every row comes back and **nobody can
  sign in**. Every person would have to be re-invited and reconnected by
  hand. That was 3 accounts on 26 Sept; after go-live it is every tenant.

**Why the 24 Sept drill missed it:** its locally built database had **no
users**, so there was nothing for the keys to refuse. The manifest's own
`doesNotCover` said "Auth users … are not restored by this"; the drill is what
turned that sentence into three refused constraints.

Supabase's daily backups (dashboard → Database → Backups) do include `auth`.
The gap was only in the copy that leaves Supabase, which is the copy meant to
survive losing Supabase.

## Fix, 26 Sept 2026

`scripts/backup-database.mjs` now writes a second archive,
`<name>.auth.dump.enc`:

- the structure of the whole `auth` schema, and the **data** of only
  `users`, `identities`, `mfa_factors`, `webauthn_credentials` and the MFA
  recovery-code tables. This is a whitelist, so a table Supabase adds later is
  not copied until someone decides it should be;
- **no** sessions, refresh tokens, one-time tokens, challenges or flow state.
  The script reads the archive back and deletes both files if any of them
  carries data;
- **always encrypted**, because it holds password hashes and TOTP secrets.
  The plaintext is deleted on success and on every failure path, including a
  mistyped passphrase confirmation.

`restore-drill-check.sql` now also prints `auth: users / identities /
mfa_factors` and **"app users with no sign-in account"**, which must be 0.

### Proven locally before release

A production-shaped database was built from Supabase's own published `auth`
migrations (76 files, 27 tables) plus all 323 of ours. It was seeded with 3
accounts, identities, a verified TOTP factor, MFA backup codes, a password
reset, **and a live session with a refresh token**.

| Test | Result |
|---|---|
| New backup: two files, accounts archive encrypted, plaintext gone | ✅ |
| Live refresh token inside the accounts archive | ✅ **0** occurrences |
| Drill into plain Postgres (accounts, then prep, then dump) | ✅ foreign **271** = manifest; 1 benign error; `auth: users 3`, `identities 3`, `mfa_factors 1`; **0** app users without a sign-in |
| Restored passwords verify against their bcrypt hashes | ✅ all 3 |
| **Negative control:** the old procedure on the same backup | ❌ 3 refused keys, foreign 268; the check flags **3** app users without a sign-in. Production's failure, reproduced |
| Into a fresh Supabase-shaped project (own empty `auth`): prep → accounts data (`users` first) → dump | ✅ foreign 271; 0 without sign-in |
| Same, all auth tables in one `pg_restore` | ❌ `identities` and `mfa_factors` refused (loaded before `users`). This is why the procedure says `users` first |

⚠️ **Not yet proven:** the new-project path against a **real** new Supabase
project, including whether it lets `postgres` write into `auth`. It was
proven against Supabase's published schema on plain PostgreSQL only.

## Re-run with the fixed script: ✅ PASSED, 26 Sept 2026, closes 4.5

**Backup:** `production-civwriqvghvyqtfrzftu-2026-09-26T09-55-22`, taken on
`main` at `c275dc2` (PR #69). Two files:
- `.dump`: 1.4 MB, 80 tables of data, sha256 `f0acfd94…e2f71a56`.
- `.auth.dump.enc`: 93 KB plaintext, sha256 `79563cb8…a3e1ea`. It holds data for
  `users`, `identities`, `mfa_factors`, `webauthn_credentials` and the two
  recovery-code tables, and **no sessions or tokens**.

Real Supabase allowed `postgres` to dump the `auth` schema, the one step that
could not be tested locally. The accounts archive was encrypted, proven to
round-trip, and then **decrypted on the operator's machine with the escrowed
passphrase**.
**Order:** accounts archive → `restore-target-prep.sql` → app data → check,
into a fresh `postgres:17` container.

| | manifest | restored |
|---|---|---|
| schema / migrations | `0302…` / 323 | `0302…` / 323 |
| foreign | 271 | **271** |
| check / primary / unique / trigger | 146 / 80 / 25 / 4 | identical |
| exclusion (`leases_no_overlap`) | 1 | 1, **PRESENT** |
| rows: orgs, users, tickets, audit_log | 4, 3, 1, 292 | identical |
| rows: the other 8 counted tables | 0 | 0 |
| auth: users / identities / mfa_factors | 3 / 3 / 1 | **3 / 3 / 1** |
| app users with no sign-in account | — | **0** |

Every line equals the manifest. The operator reported the restore steps
complete; their error output was not pasted. The 271 foreign keys and the
identical constraint set are the evidence that nothing refused. A production
backup now restores into a system people can sign in to.

📌 **`tickets = 1` in production** in both backups. Production was proven
empty of tickets on 24 Sept. The row is most likely from the 25 Sept
live-message or live-update testing. It must be identified and removed
before the external pen test (1.11/6.2), which needs an empty production.

## As first written, before the re-run

## To close 4.5

Take a new backup with the fixed script (`npm run backup`: two files,
passphrase asked), run the drill as `BACKUP_AND_RESTORE.md` §4 now describes
it, and match every line of the check against the manifest. That includes
`auth.rowCounts` and "app users with no sign-in account = 0".

## Follow-up: the stray ticket, removed 26 Sept 2026

The ticket both backups carried was the operator's own test message to OEA's
WhatsApp number (25 Sept 08:26 UTC, "Leaking kitchen tap at Flat 2…"). It had
no messages, attachments, payments, requisitions or evaluations, and carried
2 notifications and 1 chat-conversation pointer. Removed in production with
`docs/sql/remove-test-ticket-20260925.sql`, which refuses unless it is the
only ticket and nothing with money attached points at it:

| after removal | n |
|---|---|
| tickets | 0 |
| ticket_messages | 0 |
| ticket_attachments | 0 |
| ticket notifications | 0 |
| conversations pointing at a ticket | 0 |

**Who has messaged production:** `chat_webhook_events` holds 3 messages,
OEA WhatsApp only, 1 distinct sender, 25 Sept 08:26–22:44 UTC. The operator
confirmed, by matching the last four digits and without displaying the
number, that all 3 are from their own phone. No customer data has reached
production. The only personal data left in the chat tables is the operator's
own number, from their own tests.
