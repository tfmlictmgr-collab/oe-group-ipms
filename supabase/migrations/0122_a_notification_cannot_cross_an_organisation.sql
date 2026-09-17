-- A notification cannot cross an organisation.
--
-- Found while wiring the tenant's "report an issue" journey, which needs to
-- tell the FM/PM that a request has arrived. Before leaning on `notify_role`
-- for that, it was worth asking what it actually permits.
--
-- ⚠️ Both notification functions are SECURITY DEFINER, both are granted to
-- `authenticated`, and NEITHER checks the caller against the organisation it
-- is writing into:
--
--   * `notify_role(p_org_id, ...)` takes the target organisation as an
--     ARGUMENT and inserts straight from it. Any signed-in user could name any
--     other org and write into every admin's inbox there.
--   * `notify_user(p_user_id, ...)` derives the org from the RECIPIENT — which
--     reads like a safety check but is the opposite of one: it makes the
--     function work for any recipient in the database, and only fails for a
--     user who does not exist.
--
-- Proven live before writing this, then rolled back: a TFML tenant wrote a
-- notification titled "Urgent: verify your bank details" into an OEA
-- administrator's inbox, and a second one directly at a named OEA user. Both
-- succeeded.
--
-- Two things are wrong with that, and the smaller one is the data. B1 says a
-- user on one portal must never see the other brand's data OR EXISTENCE; a
-- notification that arrives from outside proves the other org exists, names a
-- reachable person inside it, and does so in the one surface a user is trained
-- to trust. The title and body are free text, so it is a phishing primitive
-- with the platform's own branding around it. `p_link` is already constrained
-- to a relative path (0025), which stops it pointing at an external site and
-- is exactly why the remaining gap matters: the address was guarded, the
-- sender never was.
--
-- The fix is the shape 0110 used for `create_rent_payment_intent`: derive the
-- boundary from the caller's session, and skip the check entirely when there
-- is no session. A service-role caller — the rent-demand job, the lease-notice
-- job, the payment webhook — has `auth.uid() = null`, legitimately writes
-- across every org, and is trusted by definition. A signed-in caller is not.

create or replace function notify_user(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_entity_type text default null,
  p_entity_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select org_id into v_org from users where id = p_user_id and deactivated_at is null;
  if v_org is null then
    return null;  -- unknown or deactivated recipient: nothing to do
  end if;

  -- The check this never had. A signed-in caller may only notify someone in
  -- their OWN organisation; a service-role caller (auth.uid() is null) may
  -- notify anyone, which is what the scheduled jobs rely on.
  --
  -- Returns null rather than raising, matching the deactivated-recipient case
  -- three lines above: from the caller's side "there is no such person to
  -- notify" and "that person is not yours to notify" should be the same
  -- non-event. A refusal would confirm the user exists — the same reasoning
  -- decision 12 applies to `operator_org_directory()`.
  if auth.uid() is not null and v_org is distinct from current_user_org_id() then
    return null;
  end if;

  -- Only ever an in-app path, never an absolute URL, so a notification cannot
  -- be used to send someone to an external site.
  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  values (v_org, p_user_id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function notify_role(
  p_org_id uuid,
  p_roles user_role[],
  p_kind text,
  p_title text,
  p_body text default null,
  p_link text default null,
  p_entity_type text default null,
  p_entity_id uuid default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  -- Same boundary, stated on the argument rather than the recipient — this one
  -- is handed the organisation, so this is the only place it can be checked.
  if auth.uid() is not null and p_org_id is distinct from current_user_org_id() then
    return 0;
  end if;

  if p_link is not null and p_link !~ '^/' then
    raise exception 'notification link must be a relative path';
  end if;

  insert into user_notifications (org_id, user_id, kind, title, body, link, entity_type, entity_id)
  select p_org_id, u.id, p_kind, p_title, p_body, p_link, p_entity_type, p_entity_id
  from users u
  where u.org_id = p_org_id and u.role = any(p_roles) and u.deactivated_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- `create or replace` preserves existing grants, but both are restated so this
-- file alone says who may call them — and so `verify-function-grants` can read
-- the intent from the migration rather than inferring it.
revoke all on function notify_user(uuid, text, text, text, text, text, uuid) from public;
revoke all on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) from public;
grant execute on function notify_user(uuid, text, text, text, text, text, uuid) to authenticated, service_role;
grant execute on function notify_role(uuid, user_role[], text, text, text, text, text, uuid) to authenticated, service_role;

comment on function notify_user is
  'Writes one in-app notification. A signed-in caller may only notify someone in their own organisation -- silently a no-op otherwise, matching the deactivated-recipient case, because refusing would confirm the recipient exists. A service-role caller (auth.uid() null: scheduled jobs, webhooks) may notify across orgs, which is what those jobs rely on.';

comment on function notify_role is
  'Notifies every active holder of a role in an org. A signed-in caller may only name their OWN org; a service-role caller may name any. The link must be relative, checked here as well as in notify_user -- this function never inherited that check.';
