-- Consent to be contacted on a messaging channel — recorded, not assumed.
--
-- ── The gap this closes ────────────────────────────────────────────────────
-- `users.notify_whatsapp` is a PREFERENCE: a boolean saying "route to WhatsApp
-- if you have something to send." It is not consent, and it cannot be made into
-- consent by renaming it, for the same reason 0062 refused to store a tick box
-- for tenancy applications: "Recorded as WHEN and TO WHAT, not a boolean --
-- 'they ticked a box' is not a record of what they agreed to."
--
-- Two separate obligations both require the stronger thing:
--
--   • WhatsApp's own platform rules require the business to hold opt-in before
--     sending a template (business-initiated) message. Sending without it risks
--     the WABA, which for us is both brands' inbound channel.
--   • NDPA s.25 requires a lawful basis, and where that basis is consent it
--     must be demonstrable. "The column was true" demonstrates nothing: it
--     carries no date, no wording, and no history, so it cannot distinguish
--     consent from a default, nor show what changed when.
--
-- ── Why this is append-only ────────────────────────────────────────────────
-- A withdrawal is a NEW ROW, never an edit or a delete of the grant. This is
-- the same shape as `audit_log` (no UPDATE or DELETE policy, 0001) and for the
-- same reason: the question a regulator asks is not "do they consent now" but
-- "what were you entitled to send on the day you sent it." An UPDATE-in-place
-- design answers the first and destroys the evidence for the second — and it
-- would let a withdrawal silently rewrite history that a data subject may later
-- need to contest.
--
-- ── What this deliberately does NOT do ─────────────────────────────────────
-- It does not become the lawful basis for every notice. Service messages about
-- someone's own tenancy or their own invoice rest on CONTRACT
-- (NDPA_COMPLIANCE_PACK.md s.3), and that basis does not evaporate because a
-- person withdraws a channel preference — it means we reach them another way.
-- What withdrawal removes is permission to use THAT CHANNEL, which is exactly
-- what WhatsApp's rules govern. The cascade already falls through to SMS and
-- email, so withdrawal degrades the route, never the notice.

create table channel_consents (
  id uuid primary key default gen_random_uuid(),
  org_id  uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,

  channel text not null check (channel in ('whatsapp', 'telegram', 'sms', 'email')),

  -- 'granted' or 'withdrawn'. Both are rows; neither overwrites the other.
  action text not null check (action in ('granted', 'withdrawn')),

  -- THE EXACT WORDING THE PERSON SAW, copied at the moment they acted -- not a
  -- key into a copy table that a later edit would silently rewrite underneath
  -- them. 0062's reasoning, applied again: "when the copy changes, existing
  -- applicants keep the statement they actually agreed to."
  --
  -- Null is permitted for 'withdrawn' only (see the CHECK below): withdrawal is
  -- an act, not an agreement to anything, so there is no statement to preserve.
  statement text,

  -- The identifier consent was given FOR. A person who changes their phone
  -- number has not consented for the new one, and silently carrying consent
  -- across would send a template to whoever now holds the old number. Stored
  -- so the send path can compare, not merely for the record.
  channel_identifier text,

  recorded_at timestamptz not null default now(),

  -- Who performed the act. Normally the person themselves; a staff member
  -- recording a consent given verbally or on paper must be visible AS a third
  -- party, because "the tenant consented" and "an administrator says the tenant
  -- consented" are different evidentiary claims and must not look alike.
  recorded_by uuid references users(id),
  recorded_via text not null default 'self_service'
    check (recorded_via in ('self_service', 'staff_recorded', 'import')),

  constraint channel_consents_grant_has_statement check (
    action <> 'granted' or (statement is not null and length(trim(statement)) > 0)
  )
);

create index channel_consents_lookup_idx
  on channel_consents (user_id, channel, recorded_at desc);
create index channel_consents_org_idx on channel_consents (org_id);

alter table channel_consents enable row level security;

-- A person may read their own consent history. That is a data-subject ACCESS
-- right (NDPA s.34 / the pack's s.7), and it is the record most likely to be
-- disputed, so self-service visibility is the point rather than a convenience.
create policy channel_consents_select_own on channel_consents for select
  using (user_id = auth.uid());

-- Staff who administer people may read their own org's records -- needed to
-- answer a rights request and to evidence the basis for a send. Scoped to the
-- existing permission rather than to a role list, so it tracks the B7 matrix
-- instead of drifting from it.
create policy channel_consents_select_staff on channel_consents for select
  using (org_id = current_user_org_id() and has_permission('people.manage'));

-- No INSERT, UPDATE or DELETE policy, deliberately and permanently.
--   • INSERT goes through the definer functions below, which stamp org_id,
--     recorded_by and recorded_via from the SESSION. A direct insert policy
--     would let a caller assert any of the three -- including writing a
--     'self_service' grant on someone else's behalf, which is precisely the
--     forgery this table exists to make impossible.
--   • UPDATE and DELETE have no legitimate caller at all. See the header.
comment on table channel_consents is
  'Append-only record of consent to be contacted on a channel. A withdrawal is a NEW ROW, never an edit -- the question is what we were entitled to send ON THE DAY WE SENT IT. No INSERT/UPDATE/DELETE policy exists by design; writes go through record_my_channel_consent / withdraw_my_channel_consent. Do not add one without re-reading 0148.';

-- Consent changes are governance-relevant and directly evidential -> audit them.
create trigger audit_channel_consent_write
  after insert or update or delete on channel_consents
  for each row execute function log_audit('channel_consent.write');


/**
 * The person grants consent for a channel, for themselves.
 *
 * `p_statement` is the wording actually displayed. The caller passes it rather
 * than the function generating it, because the UI is what the person read and
 * only the UI knows what it said -- a server-side constant would drift from the
 * screen the moment either changed independently.
 */
create or replace function record_my_channel_consent(
  p_channel text,
  p_statement text,
  p_identifier text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'you must be signed in';
  end if;
  if p_channel not in ('whatsapp', 'telegram', 'sms', 'email') then
    raise exception 'unknown channel';
  end if;
  if p_statement is null or length(trim(p_statement)) = 0 then
    -- Refused rather than defaulted. A consent row with no statement is
    -- indistinguishable from the tick box this table replaced.
    raise exception 'a consent record must carry the wording that was shown';
  end if;

  select org_id into v_org from users where id = v_uid;
  if v_org is null then
    raise exception 'no organisation for this account';
  end if;

  insert into channel_consents (
    org_id, user_id, channel, action, statement, channel_identifier,
    recorded_by, recorded_via
  )
  values (
    v_org, v_uid, p_channel, 'granted', trim(p_statement),
    nullif(trim(p_identifier), ''), v_uid, 'self_service'
  )
  returning id into v_id;

  return v_id;
end;
$$;

/**
 * The person withdraws consent for a channel, for themselves.
 *
 * This is the self-service withdrawal NDPA_COMPLIANCE_PACK.md s.7 records as
 * missing ("No self-service withdrawal. Manual."). Withdrawal must be as easy
 * as granting -- a consent that is hard to retract is not freely given.
 *
 * It also switches the delivery PREFERENCE off in the same transaction, so the
 * two can never disagree: a person who withdraws must not keep receiving
 * messages because a boolean elsewhere still said yes.
 */
create or replace function withdraw_my_channel_consent(p_channel text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'you must be signed in';
  end if;
  if p_channel not in ('whatsapp', 'telegram', 'sms', 'email') then
    raise exception 'unknown channel';
  end if;

  select org_id into v_org from users where id = v_uid;
  if v_org is null then
    raise exception 'no organisation for this account';
  end if;

  insert into channel_consents (
    org_id, user_id, channel, action, statement, recorded_by, recorded_via
  )
  values (v_org, v_uid, p_channel, 'withdrawn', null, v_uid, 'self_service')
  returning id into v_id;

  update users set
    notify_whatsapp = case when p_channel = 'whatsapp' then false else notify_whatsapp end,
    notify_telegram = case when p_channel = 'telegram' then false else notify_telegram end,
    notify_sms      = case when p_channel = 'sms'      then false else notify_sms      end,
    -- Email is NOT switched off here. It is the fallback of last resort in the
    -- B8 cascade and the only channel guaranteed to carry a notice someone is
    -- contractually owed -- a statement, an invoice, a decision. Withdrawing
    -- email consent is recorded, and it stops MARKETING, but it cannot leave a
    -- person with no way to receive what their tenancy entitles them to.
    notify_email    = notify_email
  where id = v_uid;

  return v_id;
end;
$$;

/**
 * Does this person currently consent to this channel, for this identifier?
 *
 * The answer is derived from the LATEST row, never from a stored flag -- a
 * cached "is_consented" column is the thing that goes stale and sends a
 * template to someone who withdrew last week.
 *
 * ⚠️ Identifier-sensitive by design. Consent recorded against one phone number
 * does not carry to a different one: numbers get recycled, and a template sent
 * to a reassigned number is a disclosure of the previous holder's business to a
 * stranger. When the consent row named an identifier and the current one
 * differs, this returns false and the person is asked again.
 */
create or replace function has_channel_consent(
  p_user_id uuid,
  p_channel text,
  p_identifier text default null
)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare
  v_row channel_consents%rowtype;
begin
  select * into v_row from channel_consents
  where user_id = p_user_id and channel = p_channel
  order by recorded_at desc, id desc
  limit 1;

  if v_row.id is null then return false; end if;
  if v_row.action <> 'granted' then return false; end if;

  if v_row.channel_identifier is not null
     and nullif(trim(coalesce(p_identifier, '')), '') is distinct from v_row.channel_identifier then
    return false;
  end if;

  return true;
end;
$$;

/**
 * A person's own consent history, newest first -- the self-service half of a
 * subject-access request for this record.
 */
create or replace function my_channel_consents()
returns table (
  channel text,
  action text,
  statement text,
  channel_identifier text,
  recorded_at timestamptz,
  recorded_via text
) language sql security definer stable set search_path = public as $$
  select c.channel, c.action, c.statement, c.channel_identifier,
         c.recorded_at, c.recorded_via
  from channel_consents c
  where c.user_id = auth.uid()
  order by c.recorded_at desc, c.id desc;
$$;

-- Grants: exactly the callers each function has, and no others. `anon` gets
-- nothing -- consent is meaningless from an unauthenticated caller, and 0114
-- exists because that was once assumed rather than enforced.
revoke all on function record_my_channel_consent(text, text, text) from public;
revoke all on function withdraw_my_channel_consent(text) from public;
revoke all on function has_channel_consent(uuid, text, text) from public;
revoke all on function my_channel_consents() from public;

grant execute on function record_my_channel_consent(text, text, text) to authenticated;
grant execute on function withdraw_my_channel_consent(text) to authenticated;
grant execute on function my_channel_consents() to authenticated;
-- has_channel_consent is NOT granted to authenticated: it answers a question
-- about an arbitrary user_id, and the send path that needs it runs as the
-- service role. Granting it would let any signed-in person probe whether any
-- other person is contactable on WhatsApp.
