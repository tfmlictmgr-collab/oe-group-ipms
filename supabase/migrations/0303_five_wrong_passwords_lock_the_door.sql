-- Five wrong passwords lock the door (26 Sept 2026, operator's instruction
-- during the security self-assessment).
--
-- The rule, as asked for:
--   • every failed password attempt is counted, for every org and every role;
--   • the wait before the next attempt grows — 1, 2, 4, 8 minutes after
--     failures 1 to 4;
--   • the 4th failure warns that the 5th will lock the account;
--   • the 5th LOCKS it: that email reaches nothing, on any role or org, until an
--     administrator sends a reactivation link to the registered address, which
--     the person uses to set a new password;
--   • Cloudflare stays in front of every attempt.
--
-- ── Decisions taken with the operator, and why ────────────────────────────
--
-- ⚠️ COUNTED PER EMAIL, WHETHER OR NOT AN ACCOUNT EXISTS. Self-assessment A3
-- requires a wrong password and an unknown email to be word-for-word
-- indistinguishable. A warning or a wait shown only to real accounts would let
-- anyone test which addresses are customers here by typing four wrong
-- passwords. So an unknown address is counted, waits, warns and "locks" exactly
-- like a real one; only the EMAILS (the warning at 4, the notice at 5) go to a
-- real account's owner, who is the one person entitled to know. The key is a
-- SHA-256 of the normalised address, so the table never holds what strangers
-- typed.
--
-- ⚠️ THE ATTEMPT RUNS ON OUR SERVER, NOT IN THE BROWSER. Sign-in went browser →
-- Supabase, so nothing of ours ever saw a failure. Counting in the browser
-- would be skippable, and worse: a "report a failure" endpoint would let anyone
-- lock a victim out by reporting five fakes without solving Cloudflare once. So
-- the password is now checked by a server action (lib/auth/password-sign-in.ts),
-- which counts only attempts it actually made, each carrying its own Turnstile
-- token. A caller who goes round our screen straight to Supabase is not counted
-- — but still needs a fresh Cloudflare token for every guess, and once an
-- account is locked here it is ALSO banned at Supabase, which refuses every
-- route.
--
-- ⚠️ LOCKED MEANS LOCKED EVERYWHERE, AT ONCE. A ban stops new sessions and
-- refreshes, but an access token already issued lives up to an hour. The seven
-- identity functions every policy and resolver asks ("who is the caller, and
-- are they active?") learned deactivation in 0194–0197; they learn the lock
-- here, the same way, so a locked account's open tabs reach nothing on their
-- next request.
--
-- ⚠️ THE ADMINISTRATOR UNLOCKS; THE PERSON SETS THE PASSWORD. Unlocking clears
-- the lock and sends a reactivation link through this app's own reset path
-- (0139), exactly as 0258 was meant to. The administrator never learns the
-- password, so the approvals that person gives stay evidence that they alone
-- acted. "Forgot password" does NOT unlock: a lock that the person locked out
-- can lift themselves is a wait, not a lock.

-- ── 1. Where the lock lives ─────────────────────────────────────────────────

alter table users add column if not exists sign_in_locked_at timestamptz;

comment on column users.sign_in_locked_at is
  'Set when five consecutive failed password attempts locked this account (0303). While set, the identity functions treat the caller as inactive and Supabase holds a ban. Cleared only by unlock_member_sign_in (an administrator) or operator_unlock_sign_in (the ICT break-glass script).';

create table if not exists sign_in_attempts (
  email_hash      text primary key,
  failures        smallint not null default 0 check (failures between 0 and 5),
  last_failure_at timestamptz,
  locked_at       timestamptz
);

comment on table sign_in_attempts is
  'Failed password attempts per SHA-256 of the normalised email, whether or not an account exists — so the waits and the lock cannot be used to discover which addresses are customers (0303). Service role only.';

alter table sign_in_attempts enable row level security;
revoke all on sign_in_attempts from public, anon, authenticated;

-- ── 2. The rules, stated once ──────────────────────────────────────────────

-- The ONE normalisation. lib/auth/sign-in-lock.ts computes the same thing in
-- Node (sha256 of trim + lowercase, hex); verify-sign-in-lockout proves the two
-- agree, because a mismatch would silently count every attempt under a key the
-- gate never reads.
create or replace function sign_in_email_hash(p_email text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'UTF8')), 'hex');
$$;

-- The wait AFTER a given number of consecutive failures. 5 is the lock.
create or replace function sign_in_wait_seconds(p_failures int)
returns int language sql immutable set search_path = public as $$
  select case
           when p_failures <= 0 then 0
           when p_failures >= 5 then null
           else (array[60, 120, 240, 480])[p_failures]
         end;
$$;

-- Failures older than this are forgiven: a mistyped password in March does not
-- count toward a lock in June.
create or replace function sign_in_failure_window()
returns interval language sql immutable set search_path = public as $$
  select interval '24 hours';
$$;

-- ── 3. Asked before every attempt ───────────────────────────────────────────

create or replace function sign_in_gate(p_email text)
returns table (locked boolean, wait_seconds int, failures int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_row  sign_in_attempts;
  v_f    int := 0;
  v_wait int := 0;
  v_user_locked boolean;
begin
  select * into v_row from sign_in_attempts where email_hash = sign_in_email_hash(p_email);

  select exists (
    select 1 from users u
     where lower(u.email) = lower(btrim(p_email)) and u.sign_in_locked_at is not null
  ) into v_user_locked;

  if v_user_locked or v_row.locked_at is not null then
    return query select true, 0, 5;
    return;
  end if;

  if v_row.last_failure_at is not null
     and v_row.last_failure_at >= now() - sign_in_failure_window() then
    v_f := v_row.failures;
    v_wait := greatest(0, ceil(extract(epoch from
      (v_row.last_failure_at + make_interval(secs => sign_in_wait_seconds(v_f))) - now()))::int);
  end if;

  return query select false, v_wait, v_f;
end;
$$;

-- ── 4. Recorded after a refused password ─────────────────────────────────────
--
-- Returns what the caller must say and whom it must tell. `notify` is set only
-- when a REAL account's owner is to be emailed ('warn' at 4, 'locked' at 5);
-- the screen shows the same thing either way.

create or replace function record_sign_in_failure(p_email text)
returns table (
  failures int, locked boolean, wait_seconds int, notify text,
  user_id uuid, org_id uuid, full_name text, email text
)
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := sign_in_email_hash(p_email);
  v_row  sign_in_attempts;
  v_f    int;
  v_user users;
begin
  insert into sign_in_attempts (email_hash) values (v_hash) on conflict do nothing;
  select * into v_row from sign_in_attempts where email_hash = v_hash for update;

  select * into v_user from users u where lower(u.email) = lower(btrim(p_email)) limit 1;

  -- Already locked: nothing more to count, nobody to tell twice.
  if v_row.locked_at is not null or v_user.sign_in_locked_at is not null then
    return query select 5, true, null::int, null::text,
                        v_user.id, v_user.org_id, v_user.full_name, v_user.email;
    return;
  end if;

  v_f := case
           when v_row.last_failure_at is null
             or v_row.last_failure_at < now() - sign_in_failure_window() then 0
           else v_row.failures
         end + 1;

  update sign_in_attempts
     set failures = least(v_f, 5),
         last_failure_at = now(),
         locked_at = case when v_f >= 5 then now() end
   where email_hash = v_hash;

  if v_f >= 5 and v_user.id is not null then
    update users set sign_in_locked_at = now() where id = v_user.id;
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
    values (v_user.org_id, null, 'auth.sign_in_locked', 'user', v_user.id, null,
            jsonb_build_object('failures', v_f, 'locked_at', now()));
  end if;

  return query select
    least(v_f, 5),
    v_f >= 5,
    sign_in_wait_seconds(v_f),
    case when v_user.id is null then null
         when v_f = 4 then 'warn'
         when v_f >= 5 then 'locked' end,
    v_user.id, v_user.org_id, v_user.full_name, v_user.email;
end;
$$;

-- ── 5. Cleared after a password that worked ────────────────────────────────
-- Never clears a lock: a lock is lifted by a person, not by a lucky guess.
create or replace function clear_sign_in_failures(p_email text)
returns void language sql security definer set search_path = public as $$
  delete from sign_in_attempts
   where email_hash = sign_in_email_hash(p_email) and locked_at is null;
$$;

-- ── 6. Lifted by an administrator of the same organisation ─────────────────
-- The same authority as 0258's password reset, because the next step IS that
-- reset: an active admin, same org, not themselves, and the target neither
-- deactivated nor released.
create or replace function unlock_member_sign_in(p_user_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid; v_email text; v_name text;
  v_deactivated timestamptz; v_released timestamptz; v_locked timestamptz;
begin
  if not (current_user_is_active() and current_user_role() = 'admin') then
    raise exception 'only an active administrator may unlock a member''s sign-in';
  end if;
  select org_id, email, full_name, deactivated_at, email_released_at, sign_in_locked_at
    into v_org, v_email, v_name, v_deactivated, v_released, v_locked
    from users where id = p_user_id;
  if v_org is null then raise exception 'member not found'; end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'another administrator must unlock your account';
  end if;
  if v_deactivated is not null then
    raise exception '% is deactivated — restore the account first', coalesce(v_name, v_email);
  end if;
  if v_released is not null then
    raise exception 'that address has been released; the person is invited afresh';
  end if;
  if v_locked is null then
    raise exception '% is not locked', coalesce(v_name, v_email);
  end if;

  update users set sign_in_locked_at = null where id = p_user_id;
  delete from sign_in_attempts where email_hash = sign_in_email_hash(v_email);

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (v_org, auth.uid(), 'member.sign_in_unlocked', 'user', p_user_id,
          jsonb_build_object('sign_in_locked_at', v_locked),
          jsonb_build_object('email', v_email, 'unlocked_at', now()));
  return v_email;
end;
$$;

-- ── 7. The break-glass: ICT, from a terminal, with the service role ─────────
-- For the account no administrator can reach — the operator admin themself.
-- Service role only; recorded with no actor, because there is no signed-in
-- person, and named as break-glass so it stands out in the trail.
create or replace function operator_unlock_sign_in(p_email text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_user users;
begin
  select * into v_user from users where lower(email) = lower(btrim(p_email)) limit 1;
  delete from sign_in_attempts where email_hash = sign_in_email_hash(p_email);
  if v_user.id is null then return null; end if;
  update users set sign_in_locked_at = null where id = v_user.id;
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (v_user.org_id, null, 'operator.sign_in_unlocked_break_glass', 'user', v_user.id,
          jsonb_build_object('sign_in_locked_at', v_user.sign_in_locked_at),
          jsonb_build_object('email', v_user.email, 'unlocked_at', now()));
  return v_user.id;
end;
$$;

revoke all on function sign_in_email_hash(text)      from public, anon, authenticated;
revoke all on function sign_in_gate(text)            from public, anon, authenticated;
revoke all on function record_sign_in_failure(text)  from public, anon, authenticated;
revoke all on function clear_sign_in_failures(text)  from public, anon, authenticated;
revoke all on function operator_unlock_sign_in(text) from public, anon, authenticated;
grant execute on function sign_in_email_hash(text), sign_in_gate(text), record_sign_in_failure(text),
  clear_sign_in_failures(text), operator_unlock_sign_in(text) to service_role;
revoke all on function unlock_member_sign_in(uuid) from public, anon;
grant execute on function unlock_member_sign_in(uuid) to authenticated, service_role;

-- ── 8. Locked means inactive, in every identity function ───────────────────
--
-- Rewritten from the catalogue, as 0195 did: each function's CURRENT body
-- gains `and sign_in_locked_at is null` beside every `deactivated_at is null`,
-- so nothing else in the body can be lost to a hand-copied definition. It
-- refuses if any function lacks the test to extend, and skips one already
-- extended, so it is safe to re-run.
do $$
declare
  fn text;
  def text;
  newdef text;
begin
  foreach fn in array array[
    'public.active_uid()',
    'public.current_user_is_active()',
    'public.current_user_org_id()',
    'public.current_user_role()',
    'public.current_user_property_ids()',
    'public.current_user_vendor_ids()'
  ] loop
    def := pg_get_functiondef(fn::regprocedure);
    continue when def ~* 'sign_in_locked_at';
    newdef := regexp_replace(def,
      '(\m[a-z_]+\.)?deactivated_at is null',
      '\1deactivated_at is null and \1sign_in_locked_at is null', 'gi');
    if newdef = def then
      raise exception '% has no deactivated_at test to extend — the lock would not reach it', fn;
    end if;
    execute newdef;
  end loop;
end $$;

-- The one function that must also NAME the state, so a locked session is told
-- why it was signed out (app/dashboard/layout) rather than told it was
-- deactivated, which is a different act by a different person.
create or replace function current_user_account_state()
returns text language sql stable security definer set search_path = public as $function$
  select case
    when auth.uid() is null then 'anonymous'
    when exists (
      select 1 from users u
       where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is null
    ) then 'active'
    when exists (
      select 1 from users u
       where u.id = auth.uid() and u.deactivated_at is null and u.sign_in_locked_at is not null
    ) then 'locked'
    when exists (select 1 from users u where u.id = auth.uid()) then 'deactivated'
    else 'unknown'
  end;
$function$;

-- ── 9. Prove it, inside the migration ──────────────────────────────────────
do $$
declare
  fn text;
  h1 text; h2 text;
begin
  foreach fn in array array[
    'public.active_uid()', 'public.current_user_is_active()', 'public.current_user_org_id()',
    'public.current_user_role()', 'public.current_user_property_ids()',
    'public.current_user_vendor_ids()', 'public.current_user_account_state()'
  ] loop
    if pg_get_functiondef(fn::regprocedure) !~* 'sign_in_locked_at' then
      raise exception '% does not consult the lock', fn;
    end if;
  end loop;

  h1 := sign_in_email_hash('  Someone@Example.COM ');
  h2 := sign_in_email_hash('someone@example.com');
  if h1 <> h2 or length(h1) <> 64 then
    raise exception 'sign_in_email_hash does not normalise: % vs %', h1, h2;
  end if;

  if sign_in_wait_seconds(1) <> 60 or sign_in_wait_seconds(4) <> 480
     or sign_in_wait_seconds(5) is not null then
    raise exception 'the wait schedule is not 1, 2, 4, 8 minutes then lock';
  end if;
end $$;
