-- The reporter can correct the priority we assigned — from the portal, not
-- only from WhatsApp.
--
-- 0075 built conversational triage for the chat channels: we classify, we say
-- what we decided, and the person who reported it can push back ("it's worse
-- than that"). The portal — which A2 calls the system of record — had none of
-- it. Its form asked the tenant to pick a category and an urgency from two
-- dropdowns and wrote the row straight to `tickets` from the browser, with no
-- classification, no reference shown back, and nobody notified.
--
-- So the least-informed surface was the authoritative one, and a tenant who
-- reported a gas leak through the web portal got whatever severity they
-- happened to choose from a select box.
--
-- The classification itself is application-layer (`lib/triage.ts`, shared with
-- the webhooks). What was missing in the DATABASE is the other half of the
-- exchange: a way for a signed-in reporter to correct the priority.
--
-- ⚠️ `set_ticket_urgency_by_reporter` (0075) cannot serve the portal. It
-- identifies the reporter by `channel_sender_ref` — a phone number or Telegram
-- id — and is granted to `service_role` only, because a webhook has no session
-- to check. A portal user has the opposite: a real `auth.uid()` and no
-- sender_ref at all.
--
-- Rather than copy the rule, the rule moves down one level. Standing differs
-- per channel; what happens once standing is established does not, and that
-- part is now written once.

-- ── The rule, once ────────────────────────────────────────────────────────
--
-- ⚠️ Assumes the caller has ALREADY established that this ticket belongs to
-- this reporter. It is deliberately not granted to anyone: both callers below
-- are SECURITY DEFINER and reach it as the owner. If a third caller ever
-- appears, the standing check is its job, exactly as it is theirs.
create or replace function apply_reporter_urgency(
  p_ticket_id uuid,
  p_urgency   text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
begin
  if p_urgency not in ('critical', 'high', 'normal', 'low') then
    return false;
  end if;

  select * into t from tickets
   where id = p_ticket_id
     and status not in ('resolved', 'closed')
   for update;

  if t.id is null then
    return false;
  end if;

  -- A human has since judged this. The reporter's opinion is recorded as a
  -- message but does not overwrite a decision an operator made deliberately.
  if t.urgency_source = 'staff' then
    insert into ticket_messages (org_id, ticket_id, author, channel, body)
    values (t.org_id, t.id, 'reporter', t.channel::text,
            format('Asked for priority %s (not applied — an operator had already set it).', p_urgency));
    return false;
  end if;

  update tickets
     set urgency = p_urgency::ticket_urgency,
         urgency_source = 'reporter',
         urgency_changed_at = now(),
         -- Someone telling us it is worse than we thought is exactly the case a
         -- person should look at, so the review flag is raised, never cleared.
         requires_human_review = case
           when p_urgency in ('critical', 'high') then true
           else requires_human_review
         end
   where id = t.id;

  insert into ticket_messages (org_id, ticket_id, author, channel, body)
  values (t.org_id, t.id, 'reporter', t.channel::text,
          format('Reporter set the priority to %s.', p_urgency));

  return true;
end;
$$;

revoke all on function apply_reporter_urgency(uuid, text) from public;

comment on function apply_reporter_urgency is
  'Applies a reporter''s priority correction to a ticket whose ownership the CALLER has already established. Granted to nobody on purpose -- reached only from set_ticket_urgency_by_reporter (chat, keyed on channel_sender_ref) and set_my_ticket_urgency (portal, keyed on auth.uid()), each of which owns its own standing check.';

-- ── The chat caller, now delegating ───────────────────────────────────────
--
-- Signature and behaviour unchanged; the body below the standing check is
-- gone, because it now lives in one place.
create or replace function set_ticket_urgency_by_reporter(
  p_org_id     uuid,
  p_ticket_id  uuid,
  p_sender_ref text,
  p_urgency    text
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  -- The person correcting it must be the person who raised it. Without this,
  -- anyone who learned a ticket reference could re-prioritise someone else's.
  if not exists (
    select 1 from tickets
     where id = p_ticket_id
       and org_id = p_org_id
       and channel_sender_ref = p_sender_ref
  ) then
    return false;
  end if;

  return apply_reporter_urgency(p_ticket_id, p_urgency);
end;
$$;

revoke all on function set_ticket_urgency_by_reporter(uuid, uuid, text, text) from public;
grant execute on function set_ticket_urgency_by_reporter(uuid, uuid, text, text) to service_role;

-- ── The portal caller ─────────────────────────────────────────────────────
--
-- Standing is `sender_id = auth.uid()`: the account that raised it. Note this
-- is NOT "anyone who can see the ticket" — an FM/PM can read every request on
-- their properties, and their correction is a staff judgement (`urgency_source
-- = 'staff'`, set through the ordinary ticket controls), not a reporter's.
-- Conflating the two would let staff opinion be recorded as the reporter's.
create or replace function set_my_ticket_urgency(
  p_ticket_id uuid,
  p_urgency   text
)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return false;
  end if;

  if not exists (
    select 1 from tickets
     where id = p_ticket_id
       and sender_id = auth.uid()
       and org_id = current_user_org_id()
  ) then
    return false;
  end if;

  return apply_reporter_urgency(p_ticket_id, p_urgency);
end;
$$;

revoke all on function set_my_ticket_urgency(uuid, text) from public;
grant execute on function set_my_ticket_urgency(uuid, text) to authenticated;

comment on function set_my_ticket_urgency is
  'Lets the signed-in reporter correct the priority on a request THEY raised, from the portal -- the web equivalent of what 0075 gave the chat channels. Returns false rather than raising when the ticket is not theirs, is already closed, or an operator has since set the priority deliberately.';
