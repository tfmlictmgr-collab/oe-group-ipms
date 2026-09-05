-- A missing profile is not a deactivated one.
--
-- 0194 gave the app `current_user_is_active()` and lib/auth.ts read it as the
-- answer to "why is this profile row missing?". It is not: the function is
-- `exists(... and deactivated_at is null)`, which is equally false for an
-- account that has no `users` row at all. Three ordinary situations produce
-- that state —
--
--   • a person who authenticated but has not yet accepted their invitation, so
--     `accept_invitation` has not written their row
--   • an applicant purged under the 90-day rule (B5 decision 3) whose auth
--     user outlived their profile
--   • any auth user created outside the invitation flow, which the seeding
--     scripts do routinely
--
-- — and every one of them was being told "This account has been deactivated.
-- Please contact your administrator." That is wrong, and it is unactionable:
-- the administrator looks at the deactivation list and finds nobody.
--
-- 📌 **Same defect class as the one 0194 was written about, in the opposite
-- direction.** There, a flag that refused nothing was read as a control. Here,
-- a control that answers one question was read as answering a different one.
-- Both are a predicate used for a meaning it does not carry.
--
-- ── Still says nothing about anyone else ──────────────────────────────────
-- Takes no argument, exactly as `current_user_is_active()` does and for the
-- same reason (0194): it answers only about the caller, so it cannot be used to
-- probe whether some other person's account exists or has been closed. The
-- 'unknown' arm is deliberately not called 'no such user' — it is a statement
-- about this session's profile row, not about the world.
create or replace function current_user_account_state()
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then 'anonymous'
    when exists (
      select 1 from users u where u.id = auth.uid() and u.deactivated_at is null
    ) then 'active'
    when exists (select 1 from users u where u.id = auth.uid()) then 'deactivated'
    else 'unknown'
  end;
$$;

revoke all on function current_user_account_state() from public, anon;
grant execute on function current_user_account_state() to authenticated, service_role;

comment on function current_user_account_state is
  'Why this session has no profile: active, deactivated, unknown (authenticated but no users row - mid-invitation, purged, or created outside the invite flow), or anonymous. Takes no argument on purpose, like current_user_is_active() - it answers only about the caller and cannot enumerate anyone else. Added by 0196, because 0194''s is_active() answers false for both deactivated and never-existed and the dashboard was reporting the second as the first.';

-- `current_user_is_active()` stays exactly as 0194 left it. It is the predicate
-- the 0195 guards are written against, where "false" correctly means "refuse"
-- in both cases; only the message needed the distinction.
do $$
begin
  if (select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'current_user_account_state'
       limit 1) not like '%deactivated_at is null%' then
    raise exception 'current_user_account_state() does not consult deactivated_at';
  end if;
end;
$$;
