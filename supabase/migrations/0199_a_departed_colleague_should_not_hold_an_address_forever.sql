-- A departed colleague should not hold an address forever.
--
-- Deactivation stops an account reaching anything (0194 → 0197). It does not
-- give the ADDRESS back. `auth.users.email` is unique, so once
-- `destiny@example.com` has been enrolled, that address is spent: the person
-- cannot be re-invited when they return, their successor cannot be invited on
-- the shared role address a small office actually uses
-- (`accounts@`, `facilities@`), and a typo'd invitation
-- permanently burns the correct spelling of somebody's name.
--
-- Confirmed on the live system before writing anything: `provisionInviteAccount`
-- looks the address up through `auth_account_state()`, finds the old account,
-- sees it has a profile, and answers `existingAccount: true` — which tells the
-- invitee to sign in with a password belonging to someone who has left.
--
-- ── What this deliberately is NOT ─────────────────────────────────────────
-- ⚠️ **The old row is never reused.** Releasing the address does not hand the
-- account to the next person: it tombstones the address ON the old row and
-- leaves everything else exactly where it is. A re-invitation then finds no
-- account, creates a fresh one, and `accept_invitation` writes a NEW `users`
-- row with a NEW id.
--
-- That is the whole point, and it is not fussiness:
--   • `audit_log.actor_id` points at the OLD id, so every action the departed
--     person took stays theirs. Reusing the row would silently re-attribute
--     years of history to whoever inherited the address — the one thing A3's
--     immutable trail exists to prevent, achieved without deleting a single row.
--   • `property_stakeholders`, `vendor_users` and unit occupancy all key on the
--     user id. Reusing the row would grant the newcomer every building, company
--     and tenancy their predecessor held, silently, on day one. That is `0116`
--     and `0163`'s "evicted the first" defect arriving from the opposite
--     direction — there a second person displaced the first; here the first
--     would displace nothing and simply become the second.
--
-- ⚠️ **Never automatic.** Release is a separate, deliberate act after
-- deactivation, not a side effect of it. Most deactivations are somebody on
-- leave, a role changing, or a mistake being corrected — and every one of those
-- is followed by a restore. An address freed the moment someone is deactivated
-- would be an address the system might have already given to somebody else by
-- the time the mistake is noticed. Deactivation is reversible; this is not.
--
-- ── The tombstone ─────────────────────────────────────────────────────────
-- `released+<user_id>@invalid`. `.invalid` is reserved by RFC 2606 and can
-- never resolve, so no notification can ever be delivered to it even if some
-- future code path forgets to check `deactivated_at`. Keyed on the user id, so
-- it is unique by construction and cannot collide with another release.
--
-- The real address is kept in `former_email` — the record of who this was
-- must not be destroyed to free a string.

alter table users add column if not exists former_email text;
alter table users add column if not exists email_released_at timestamptz;

comment on column users.former_email is
  'The address this account held before it was released for re-invitation (0199). Kept because deactivation is not erasure: an auditor reading a two-year-old entry must still be able to see who acted, and "released+<uuid>@invalid" answers nobody.';

comment on column users.email_released_at is
  'When the address was released. NULL for every ordinary account, including deactivated ones — release is a separate deliberate act, never a side effect of deactivation.';

-- ── The release itself ────────────────────────────────────────────────────
create or replace function release_member_email(p_user_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_org        uuid;
  v_email      text;
  v_former     text;
  v_released   timestamptz;
  v_deactivated timestamptz;
  v_tombstone  text;
begin
  -- ⚠️ Written as a POSITIVE comparison, deliberately.
  --
  -- The neighbouring `set_member_active` guards with
  -- `if current_user_role() <> 'admin' then raise`, and since 0194 made that
  -- function return NULL for a deactivated caller, `NULL <> 'admin'` evaluates
  -- to NULL — so the `if` does not fire and execution falls THROUGH the guard.
  -- That function is saved further down by an `is distinct from` org check,
  -- which is null-safe; it is protected by accident rather than by its own
  -- guard. 0197 records this shape as a defect class. A new function must not
  -- reproduce it: `= 'admin'` is false for NULL, so this refuses.
  if not (current_user_is_active() and current_user_role() = 'admin') then
    raise exception 'only an active administrator may release a member''s email address';
  end if;

  select org_id, email, former_email, email_released_at, deactivated_at
    into v_org, v_email, v_former, v_released, v_deactivated
    from users where id = p_user_id;

  if v_org is null then
    raise exception 'member not found';
  end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'you cannot release your own address';
  end if;

  -- The account must already be closed. Releasing a live person's address would
  -- leave them signed in against an address that is being offered to somebody
  -- else, which is the one state this whole design exists to make impossible.
  if v_deactivated is null then
    raise exception
      'deactivate % first — an address can only be released from a closed account', v_email;
  end if;

  -- Idempotent on purpose. The caller has to complete a second step against the
  -- auth provider after this returns, and if that step fails the safe remedy is
  -- to run the whole thing again. Erroring on "already released" would turn a
  -- half-finished release into a permanently stuck one, so instead it answers
  -- with the tombstone it already assigned.
  if v_released is not null then
    return v_email;
  end if;

  v_tombstone := 'released+' || p_user_id::text || '@invalid';

  update users
     set former_email      = coalesce(v_former, v_email),
         email             = v_tombstone,
         email_released_at = now()
   where id = p_user_id;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'member.email_released', 'user', p_user_id,
    jsonb_build_object('email', v_email),
    jsonb_build_object('email', v_tombstone, 'former_email', coalesce(v_former, v_email))
  );

  return v_tombstone;
end;
$$;

revoke all on function release_member_email(uuid) from public, anon;
grant execute on function release_member_email(uuid) to authenticated;

comment on function release_member_email(uuid) is
  'Frees a deactivated member''s address so it can be invited again, by tombstoning it onto their own row. Never reuses the old account: a re-invitation creates a new user with a new id, so audit attribution and every property/vendor/unit attachment stay with the person who earned them. Returns the tombstone. Idempotent — the caller must still release the address on the auth provider, and re-running is the remedy if that fails.';

-- ── Prove the guard actually refuses a NULL role ──────────────────────────
-- The defect this function was written to avoid is invisible in a diff: both
-- spellings LOOK like an admin check. Only evaluating them apart tells them
-- apart, so the migration does that rather than trusting the comment above.
do $$
begin
  if (null::user_role <> 'admin') is not null then
    raise exception 'expected NULL <> admin to be NULL';
  end if;
  if coalesce(null::user_role = 'admin', false) then
    raise exception 'expected NULL = admin to be falsy';
  end if;

  if (select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'release_member_email'
       limit 1) not like '%current_user_is_active()%' then
    raise exception 'release_member_email does not check that the caller is active';
  end if;
end;
$$;
