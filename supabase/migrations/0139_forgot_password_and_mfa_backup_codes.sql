-- Self-service account recovery: a password-reset flow and MFA backup codes.
--
-- Neither existed. `docs/UX_BACKLOG.md` already named the first ("Forgot
-- password / password reset flow (not implemented at all)"); the second is
-- net-new alongside TOTP two-factor authentication.
--
-- ⚠️ Password reset does NOT use Supabase Auth's own built-in reset email.
-- This app already has a working, branded mail path (`lib/email.ts`, Resend,
-- per-org From/Reply-To) that invitations already go through — Supabase
-- Auth's built-in mailer is a separate, unconfigured system in this project
-- (no custom SMTP set), so relying on it would silently not deliver in
-- exactly the environment this is meant to work in. Same shape as
-- `invitations` (0020): a high-entropy token is shown once and only its
-- SHA-256 hash is stored, so a database read can never be replayed as a
-- working reset link.
--
-- MFA enrollment itself (the TOTP secret, the factor) is Supabase Auth's own
-- built-in `auth.mfa_factors` — nothing to build there. Backup codes are not
-- part of that API and need their own table.

create table password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index password_resets_user_idx on password_resets(user_id);
create index password_resets_unused_idx on password_resets(user_id) where used_at is null;

comment on table password_resets is
  'One-time password-reset tokens, stored as a hash only (same shape as invitations, 0020). Consumed server-side via supabaseAdmin -- the token IS the proof, so no RLS policy admits a client here at all.';

alter table password_resets enable row level security;
revoke all on password_resets from anon, authenticated;
grant all on password_resets to service_role;

-- ── MFA backup codes ────────────────────────────────────────────────────────
create table mfa_backup_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);
create index mfa_backup_codes_user_idx on mfa_backup_codes(user_id);

comment on table mfa_backup_codes is
  'Hashed one-time recovery codes for a user enrolled in TOTP MFA. Using one disables MFA for that account entirely (rather than trying to fake an AAL2 session Supabase never issued) so the person can sign in and re-enroll -- see lib/mfa.ts. Plaintext is shown exactly once, at generation, never stored or re-displayed.';

alter table mfa_backup_codes enable row level security;
revoke all on mfa_backup_codes from anon, authenticated;
grant all on mfa_backup_codes to service_role;
