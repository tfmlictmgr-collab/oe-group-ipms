-- `set_org_gateway_credential` refused the service role, which is the only
-- caller that can seed one.
--
-- ⚠️ 0156 opened with `if auth.uid() is null then raise 'your session expired'`.
-- Under the service-role client `auth.uid()` IS null by definition — so every
-- seed, fixture and back-office script was told its session had expired. Found
-- by the first run of verify-per-org-gateways, which could not store a
-- credential to test reading one back.
--
-- 📌 This is the same trap 0142 documented for `create_*_remittance`, where
-- `auth.uid()` was stamped into `created_by` through a service-role call and
-- silently wrote NULL on every row. The lesson there was "a rule enforced
-- against a null actor is not enforced"; the mirror image is "a rule that
-- REQUIRES an actor refuses every trusted system write". Both come from
-- treating `auth.uid()` as if it were always a person.
--
-- The exemption is the one every money trigger in this schema already uses —
-- `auth.uid() is null` means a trusted system write — and it is safe here for
-- the same reason: reaching the service role already means holding the
-- service-role key, which is a larger compromise than any check in this
-- function could mitigate. `configured_by` is left NULL for such a write, which
-- is honest: nobody was signed in.
--
-- The authority checks for a REAL session are unchanged, and
-- verify-per-org-gateways section 5 proves them with actual logins rather than
-- with the service role — which is the distinction that matters, and the one
-- 0157 was written after missing.

create or replace function set_org_gateway_credential(
  p_gateway        text,
  p_public_key     text,
  p_secret_enc     text,
  p_webhook_enc    text,
  p_key_mode       text,
  p_secret_last4   text,
  p_org_id         uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := coalesce(p_org_id, current_user_org_id());
  v_id  uuid;
begin
  -- A trusted system write (service role, seeds, fixtures). Everything below
  -- still applies; only the "who are you" test is skipped, because there is
  -- deliberately nobody to be.
  if auth.uid() is not null then
    if not (
      (v_org = current_user_org_id() and current_user_role() = 'admin')
      or caller_is_operator_admin()
    ) then
      raise exception 'only an administrator of this organisation may connect its payment gateway';
    end if;
  elsif p_org_id is null then
    -- Without a session there is no org to infer one from, and guessing would
    -- write another organisation's credential.
    raise exception 'a system write must name the organisation explicitly';
  end if;

  if p_gateway not in ('paystack', 'flutterwave') then
    raise exception 'unknown gateway %', p_gateway;
  end if;
  if p_key_mode not in ('test', 'live') then
    raise exception 'a gateway key is either test or live';
  end if;
  if p_secret_enc is null or length(p_secret_enc) < 16 then
    raise exception 'the secret key did not arrive encrypted';
  end if;

  update org_gateway_credentials
     set active = false, updated_at = now()
   where org_id = v_org and gateway = p_gateway and active;

  insert into org_gateway_credentials (
    org_id, gateway, public_key, secret_key_enc, webhook_secret_enc,
    key_mode, secret_last4, configured_by
  ) values (
    v_org, p_gateway, nullif(trim(p_public_key), ''), p_secret_enc,
    nullif(trim(p_webhook_enc), ''), p_key_mode, p_secret_last4, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function set_org_gateway_credential(text, text, text, text, text, text, uuid) from public, anon;
grant execute on function set_org_gateway_credential(text, text, text, text, text, text, uuid) to authenticated, service_role;

comment on function set_org_gateway_credential is
  'Stores an already-encrypted gateway credential. Administrators of the owning org or the operator; a service-role call is exempt from the identity test but must name the org, since there is no session to infer one from (0156, fixed 0158).';
