-- What a signed-in person may change about their own account.
--
-- ⚠️ Reported from production: the welcome notification says "You can change how
-- we reach you in Settings", and a tenant opening Settings was told
-- "Administrator access required".
--
-- The preferences themselves were never missing — `update_my_notification_prefs`
-- and the whole channel picker have worked since the notification centre landed.
-- What was wrong is that `/dashboard/settings` IS the branding page, which is
-- admin-only, so every non-admin arrived at a refusal and reasonably concluded
-- Settings held nothing for them. That half is fixed in the application.
--
-- This half is the gap the report uncovered on the way: **a person cannot
-- correct their own name.** `users` carries a SELECT policy and no UPDATE policy
-- at all, deliberately — the row holds `role` and `org_id`, and a self-service
-- UPDATE on it is one careless `with check` away from letting someone promote
-- themselves. So every self-write goes through a narrow definer function, and
-- until now exactly one existed (notification preferences).
--
-- ⚠️ `full_name` and NOTHING else. Not role, not org_id, not deactivated_at,
-- not email:
--   * role and org_id are the two columns every RLS policy in the system reads.
--     They are set by invitation and by the operator, and a function that could
--     touch them would be a privilege-escalation path wearing a friendly name.
--   * email is an authentication identity, not a display field — changing it
--     without re-verification would let someone redirect their own password
--     reset, and re-verification is a different piece of work.
create or replace function update_my_profile(p_full_name text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_name text := nullif(trim(p_full_name), '');
begin
  if auth.uid() is null then
    raise exception 'you must be signed in';
  end if;

  -- A blank name is refused rather than stored. Everything that addresses a
  -- person falls back to their email when `full_name` is null, so an empty
  -- string would be strictly worse than never having set one — it renders as a
  -- gap rather than as an address.
  if v_name is null then
    raise exception 'give a name we can address you by';
  end if;
  if length(v_name) > 120 then
    raise exception 'that name is too long (120 characters maximum)';
  end if;

  update users set full_name = v_name where id = auth.uid();
end;
$$;

revoke all on function update_my_profile(text) from public;
revoke execute on function update_my_profile(text) from anon;
grant execute on function update_my_profile(text) to authenticated;

comment on function update_my_profile is
  'Lets a signed-in person correct their own display name. `full_name` ONLY -- never role or org_id, which every RLS policy reads and which a self-service write would turn into a privilege-escalation path; and never email, which is an authentication identity and would need re-verification. `users` has no UPDATE policy by design, so this narrow definer function is the whole of what a person may change about themselves, alongside update_my_notification_prefs.';
