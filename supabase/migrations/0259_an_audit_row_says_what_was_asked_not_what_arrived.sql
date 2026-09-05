-- An audit row says what was asked, not what arrived (5 Sept 2026).
--
-- `authorise_member_password_reset` (0258) writes its audit row as
-- `member.password_reset_sent`, and it writes it BEFORE the link exists and
-- before anything is emailed. That ordering is right and is the same one
-- `release_member_email` uses deliberately: authorise and record in SQL, where
-- no write path can miss it, then do the auth-provider half in the server
-- action. A failure there leaves a state that is visibly incomplete rather than
-- silently done.
--
-- ⚠️ But the NAME then overstates it. If `generateLink` fails, or Resend
-- refuses the address, the trail still says a reset was SENT — and an audit
-- trail that records an outcome it cannot observe is worse than one that
-- records less. The only thing this function actually witnesses is that an
-- administrator asked for it, and was permitted.
--
-- 📌 Found by running the authorisation against a real member to verify the
-- refusals: the admin case returned "authorised", which wrote a row claiming a
-- reset had been sent to somebody who was never emailed anything. The check
-- worked; the vocabulary did not.
--
-- Rebuilt from the live catalogue with exactly the action string changed.
create or replace function authorise_member_password_reset(p_user_id uuid)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  v_org uuid;
  v_email text;
  v_deactivated timestamptz;
  v_released timestamptz;
  v_name text;
begin
  if not (current_user_is_active() and current_user_role() = 'admin') then
    raise exception 'only an active administrator may send a member a password reset';
  end if;

  select org_id, email, deactivated_at, email_released_at, full_name
    into v_org, v_email, v_deactivated, v_released, v_name
    from users where id = p_user_id;

  if v_org is null then
    raise exception 'member not found';
  end if;
  if v_org is distinct from current_user_org_id() then
    raise exception 'that member belongs to another organisation';
  end if;
  if p_user_id = auth.uid() then
    raise exception
      'use the "Forgot password?" link on the sign-in page for your own account';
  end if;
  if v_deactivated is not null then
    raise exception
      '% is deactivated — restore the account first, or a reset link would let a closed account back in',
      coalesce(v_name, v_email);
  end if;
  if v_released is not null then
    raise exception
      'that address has been released; the person is invited afresh rather than reset';
  end if;

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                         before_state, after_state)
  values (
    v_org, auth.uid(), 'member.password_reset_requested', 'user', p_user_id,
    null,
    jsonb_build_object('email', v_email, 'full_name', v_name, 'requested_at', now())
  );

  return v_email;
end;
$fn$;

revoke all on function authorise_member_password_reset(uuid) from public, anon;
grant execute on function authorise_member_password_reset(uuid) to authenticated, service_role;
