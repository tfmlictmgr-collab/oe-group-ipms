-- Looking up a login by email, exactly, instead of paging through every user.
--
-- `provisionInviteAccount` needed to know whether an invited address already
-- has a login, and the only thing the admin SDK offers is `listUsers({page,
-- perPage})` — enumerate, then search client-side. That works at 40 users and
-- fails quietly at scale: past the page size the account is simply not found,
-- so the code decides to create one, and the invitee is told their address is
-- already registered with no way forward. The brief puts 700+ staff on TFML
-- alone, so this is a "when", not an "if".
--
-- It is also the wrong shape regardless of size: pulling every user's record
-- across the wire to answer a question about one of them.
--
-- Returns only the three facts the decision needs — never the password hash,
-- never the token store, never other users' rows.

create or replace function auth_account_state(p_email text)
returns table (
  user_id uuid,
  is_confirmed boolean,
  has_signed_in boolean
)
language sql
security definer
set search_path = auth, public
as $$
  select u.id,
         u.email_confirmed_at is not null,
         u.last_sign_in_at is not null
    from auth.users u
   where lower(u.email) = lower(trim(p_email))
   limit 1;
$$;

comment on function auth_account_state(text) is
  'Whether an email already has a login, and whether it is confirmed and used. Service role only — it reads auth.users.';

-- Service role only. This reads the auth schema; nothing signed in as a portal
-- user has any business asking it, and an anon caller could otherwise use it to
-- enumerate which addresses hold accounts.
revoke all on function auth_account_state(text) from public, anon, authenticated;
grant execute on function auth_account_state(text) to service_role;
