-- A question is not a request, and an answer to our own question is not a new one.
--
-- Read the live WhatsApp transcript of 8–28 Aug 2026 and the same defect appears
-- four times in four different disguises. Every one of them is the same missing
-- thing: **the router has only two answers on a cold message** — `new_request`
-- or `pleasantry` (`classifyFirstContact`, lib/inbound-router.ts). There is no
-- third. So anything that is not a greeting becomes a ticket, including a
-- question *about* tickets.
--
--   "Tell me about my raised requests"  → ticket 8E147AA6
--   "1F2DBAB0 … what's the stats now?"  → ticket AE1B818E
--   "This is a test"                    → ticket 74BB9844
--   a bare "1" with nothing pending     → ticket 1F2DBAB0
--
-- And one worse than those, because it is the system contradicting itself in
-- consecutive messages:
--
--   Us:   "You have 8E147AA6 open — tell us more about it, or describe
--          something new and we'll log it separately."
--   Them: "It's about a broken ceiling in my room"
--   Us:   "Thanks — your request has been logged. Ref: 237A9C51"
--
-- We asked an open question and then read the answer as if we had never asked
-- it. The cause is in 0075: `chat_conversations.awaiting` has exactly ONE legal
-- value, `'urgency_confirmation'`. That is the only conversational state the
-- schema can hold, so the "tell us more" branch stores `awaiting = null`, the
-- router is shown no evidence that a question is outstanding, and its standing
-- instruction — prefer `new_request` unless the message *clearly* refers to the
-- same thing — splits an answer that shares no vocabulary with what it answers.
--
-- Four things are needed here. None of them is a cleverer prompt; three of them
-- are state the schema has never been able to hold.
--
--   1. more conversational states than one     → awaiting widened
--   2. memory of what WE last said             → chat_conversations.last_prompt
--   3. a way to ANSWER "what have I got open"  → sender_open_requests
--   4. a quoted reference resolving to its own
--      ticket, past the 24-hour window         → resolve_ticket_by_ref
--
-- ⚠️ Every function here is service_role only, for the same reason 0114 had to
-- go back and revoke the last set: these are SECURITY DEFINER over a
-- caller-supplied org id and sender ref, called from a webhook on behalf of
-- somebody who is not signed in. A client session that could pass its own
-- arguments would be reading other people's requests.

-- ── 1. A conversation has more than one state ──────────────────────────────
--
-- `describe_problem`      we asked them what is wrong / to say more, and are
--                         waiting for the answer. The state that would have
--                         prevented 237A9C51.
-- `disambiguate_ticket`   we listed their open requests and asked which one
--                         they mean.
--
-- Still deliberately a small closed set. This is not a dialogue engine; it is
-- the minimum needed so that a reply to a question we asked is recognisable as
-- one.
alter table chat_conversations drop constraint if exists chat_conversations_awaiting_check;
alter table chat_conversations add constraint chat_conversations_awaiting_check
  check (awaiting in ('urgency_confirmation', 'describe_problem', 'disambiguate_ticket'));

-- ── 2. What we last said to them ───────────────────────────────────────────
--
-- The router has always been shown what the REPORTER said and never what WE
-- said. So "But that wasn't a request" was judged as an opening line rather
-- than as the objection to our own acknowledgement that it plainly is.
--
-- `conversation_transcript` (0113) carries our side only once a ticket exists.
-- The messages that go wrong are the ones where it does not.
alter table chat_conversations add column if not exists last_prompt text;

comment on column chat_conversations.last_prompt is
  'The last thing WE said to this sender, so their next message can be read as a reply to it. Distinct from conversation_transcript, which only exists once a ticket does -- and the exchanges that get misread are precisely the ones with no ticket yet.';

-- ── One writer for that row ────────────────────────────────────────────────
--
-- `remember_conversation` (0075) cannot carry the two new fields, and widening
-- it in place would change a signature that a verification script and an
-- earlier migration both name explicitly. So the writer moves down one level —
-- the same shape 0124 used when `apply_reporter_urgency` was lifted out of
-- `set_ticket_urgency_by_reporter`, and the same rule as decision 8: one
-- resolver, extended, never a second one alongside.
create or replace function remember_conversation_state(
  p_org_id      uuid,
  p_channel     text,
  p_sender_ref  text,
  p_ticket_id   uuid,
  p_awaiting    text,
  p_last_prompt text,
  p_hours       integer default 24
)
returns void language sql security definer set search_path = public as $$
  insert into chat_conversations
    (org_id, channel, sender_ref, last_ticket_id, awaiting, last_prompt, expires_at, updated_at)
  values
    (p_org_id, p_channel, p_sender_ref, p_ticket_id, p_awaiting, p_last_prompt,
     now() + make_interval(hours => p_hours), now())
  on conflict (org_id, channel, sender_ref) do update
     set last_ticket_id = excluded.last_ticket_id,
         awaiting       = excluded.awaiting,
         last_prompt    = excluded.last_prompt,
         expires_at     = excluded.expires_at,
         updated_at     = now();
$$;

revoke execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) from anon, authenticated;
grant execute on function remember_conversation_state(uuid, text, text, uuid, text, text, integer) to service_role;

comment on function remember_conversation_state is
  'The single writer of chat_conversations. remember_conversation (0075) delegates here rather than keeping a second copy of the upsert -- two statements that must agree eventually will not.';

-- Unchanged signature and unchanged behaviour; the body now delegates. A caller
-- that does not know about `last_prompt` clears it, which is correct: it did not
-- say anything, so there is nothing outstanding to remember.
create or replace function remember_conversation(
  p_org_id     uuid,
  p_channel    text,
  p_sender_ref text,
  p_ticket_id  uuid,
  p_awaiting   text,
  p_hours      integer default 24
)
returns void language sql security definer set search_path = public as $$
  select remember_conversation_state(
    p_org_id, p_channel, p_sender_ref, p_ticket_id, p_awaiting, null, p_hours
  );
$$;

revoke execute on function remember_conversation(uuid, text, text, uuid, text, integer) from anon, authenticated;
grant execute on function remember_conversation(uuid, text, text, uuid, text, integer) to service_role;

-- ── 3. The state, readable WITHOUT a ticket ────────────────────────────────
--
-- ⚠️ `conversation_context` (0075) inner-joins `tickets` on `last_ticket_id`, so
-- it returns nothing at all when there is no ticket yet — which is exactly the
-- case where we have just asked "what needs attention, and where?" and need to
-- remember that we asked. The outstanding question was therefore unreadable in
-- precisely the situation it exists for.
--
-- A NEW function rather than a widened one, for the reason 0113 already
-- recorded: Postgres refuses `create or replace` when a table-returning
-- function's row shape changes, so widening `conversation_context` means
-- dropping and recreating something that works, and this build has been bitten
-- by that more than once.
create or replace function conversation_state(
  p_org_id uuid, p_channel text, p_sender_ref text
)
returns table (
  awaiting text,
  last_prompt text,
  last_ticket_id uuid
)
language sql stable security definer set search_path = public as $$
  select c.awaiting, c.last_prompt, c.last_ticket_id
    from chat_conversations c
   where c.org_id = p_org_id
     and c.channel = p_channel
     and c.sender_ref = p_sender_ref
     and c.expires_at > now();
$$;

revoke execute on function conversation_state(uuid, text, text) from anon, authenticated;
grant execute on function conversation_state(uuid, text, text) to service_role;

comment on function conversation_state is
  'What we last asked this sender and what we last said, whether or not a ticket exists. conversation_context answers the same question only when there IS a ticket -- and the exchange that gets misread is the one before there is.';

-- ── 4. Answering "what have I got open?" ───────────────────────────────────
--
-- The bot has never been able to answer a question. `conversation_context`
-- returns the ONE ticket it happened to remember within 24 hours; there was no
-- way to ask "what does this person have open", so "Tell me about my raised
-- requests" had nowhere to go but the ticket table.
--
-- Ownership is the same rule the reporter RPCs have used since 0075 — the
-- channel they wrote from is the authority — widened by the one identity 0064
-- already establishes: if their number resolves to exactly one user in this
-- org, requests they raised on the PORTAL are theirs too. `resolve_chat_sender`
-- refuses an ambiguous number, so a shared or unrecognised one simply falls
-- back to the channel ref and nothing extra is shown.
create or replace function sender_open_requests(
  p_org_id     uuid,
  p_sender_ref text,
  p_limit      integer default 5
)
returns table (
  ticket_id  uuid,
  reference  text,
  category   text,
  urgency    text,
  status     text,
  summary    text,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid;
begin
  select r.user_id into v_user from resolve_chat_sender(p_org_id, p_sender_ref) r;

  return query
    select t.id,
           upper(left(replace(t.id::text, '-', ''), 8)),
           t.category::text,
           t.urgency::text,
           t.status::text,
           t.summary,
           t.created_at
      from tickets t
     where t.org_id = p_org_id
       and t.status not in ('resolved', 'closed')
       and (
         t.channel_sender_ref = p_sender_ref
         or (v_user is not null and t.sender_id = v_user)
       )
     order by t.created_at desc
     limit greatest(1, least(coalesce(p_limit, 5), 10));
end;
$$;

revoke execute on function sender_open_requests(uuid, text, integer) from anon, authenticated;
grant execute on function sender_open_requests(uuid, text, integer) to service_role;

comment on function sender_open_requests is
  'Everything this chat sender currently has open, so a question about their own requests can be ANSWERED instead of logged as a new one. Ownership is the channel ref, plus -- only when resolve_chat_sender identifies exactly one user -- what that account raised on the portal.';

-- ── 5. A quoted reference finds its own ticket ─────────────────────────────
--
-- "1F2DBAB0 This ought to be a fix for my toilet, what's the stats now?" named
-- the ticket and was still filed as a new one, because nothing anywhere reads a
-- reference out of a message body. The thread was only ever "whatever this
-- sender was last talking about, if it was within 24 hours".
--
-- Deliberately NOT bounded by that window and NOT restricted to open tickets: a
-- person quoting a reference three days later means that ticket, and asking
-- after one that has since been closed deserves "it is closed" rather than a
-- fifth duplicate. `is_open` is returned so the caller can tell the difference —
-- the write RPCs (`append_reporter_message`, `set_ticket_urgency_by_reporter`)
-- still refuse a closed ticket on their own, exactly as before.
create or replace function resolve_ticket_by_ref(
  p_org_id     uuid,
  p_sender_ref text,
  p_ref        text
)
returns table (
  ticket_id    uuid,
  reference    text,
  category     text,
  urgency      text,
  status       text,
  message_text text,
  created_at   timestamptz,
  is_open      boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid;
  v_ref  text;
begin
  -- Whatever they typed, reduced to the eight hex characters a reference is.
  -- Tolerates "ref: 1f2dbab0", "#1F2DBAB0" and lower case.
  v_ref := upper(regexp_replace(coalesce(p_ref, ''), '[^0-9A-Fa-f]', '', 'g'));
  if length(v_ref) <> 8 then
    return;
  end if;

  select r.user_id into v_user from resolve_chat_sender(p_org_id, p_sender_ref) r;

  return query
    select t.id,
           upper(left(replace(t.id::text, '-', ''), 8)),
           t.category::text,
           t.urgency::text,
           t.status::text,
           t.message_text,
           t.created_at,
           (t.status not in ('resolved', 'closed'))
      from tickets t
     where t.org_id = p_org_id
       and upper(left(replace(t.id::text, '-', ''), 8)) = v_ref
       -- ⚠️ The reference is a hint, never the authority. Knowing a reference
       -- must not be enough to read someone else's request -- the same rule
       -- 0075 wrote into set_ticket_urgency_by_reporter, and the reason it
       -- keys on channel_sender_ref rather than on the ticket id alone.
       and (
         t.channel_sender_ref = p_sender_ref
         or (v_user is not null and t.sender_id = v_user)
       )
     limit 1;
end;
$$;

revoke execute on function resolve_ticket_by_ref(uuid, text, text) from anon, authenticated;
grant execute on function resolve_ticket_by_ref(uuid, text, text) to service_role;

comment on function resolve_ticket_by_ref is
  'The ticket a sender named by reference in their own message, if it is theirs. Not bounded by the 24-hour conversation window -- quoting a reference IS the context -- and returns closed ones with is_open false so a status question can be answered honestly rather than becoming a duplicate.';
