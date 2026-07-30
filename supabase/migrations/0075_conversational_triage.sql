-- Intake that can hold a conversation.
--
-- Board, 29 July 2026: the classifier should be interactive — a person must be
-- able to correct a priority the AI got wrong — and handle more nuanced exchanges
-- within scope.
--
-- The gap underneath that request is larger than the request. **Every inbound
-- message currently creates a new ticket.** There is no conversation state and no
-- place to put a follow-up, so "the leak is worse now" opens a second ticket
-- rather than updating the first, and `/start` opened one too. Worse, the
-- acknowledgement already ends with "If the category or priority looks wrong,
-- reply and we'll correct it" — and replying creates another ticket. A promise
-- the system does not keep, the same shape as the resume link that was never
-- emailed.
--
-- Three things are needed, and none of them is a cleverer prompt:
--   1. somewhere for a follow-up to go            → ticket_messages
--   2. memory of what this sender last wrote      → chat_conversations
--   3. a guarded way to act on a correction       → the two RPCs below

-- ── 1. A ticket can hold a conversation ────────────────────────────────────
--
-- The composite foreign key below needs something to point at, and it has to
-- exist BEFORE the table that references it — a constraint is validated as the
-- table is created, not afterwards.
create unique index if not exists tickets_id_org_uidx on tickets (id, org_id);

create table ticket_messages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  ticket_id  uuid not null references tickets(id) on delete cascade,

  -- Who said it. `reporter` is the person who raised it, identified by the
  -- channel they wrote from; `staff` is an authenticated user; `system` is us.
  author     text not null check (author in ('reporter', 'staff', 'system')),
  author_id  uuid references users(id),

  channel    text,                       -- whatsapp / telegram / portal, when inbound
  body       text not null check (length(trim(body)) > 0),

  created_at timestamptz not null default now(),

  -- Same-org enforcement as structure, not as a policy clause.
  constraint ticket_messages_ticket_same_org_fk
    foreign key (ticket_id, org_id) references tickets (id, org_id)
);

create index ticket_messages_ticket_idx on ticket_messages (ticket_id, created_at);

alter table ticket_messages enable row level security;

-- Visible to exactly whoever may see the ticket. Delegating to `tickets` rather
-- than restating its predicate means the two can never drift apart — and that
-- predicate is already the B7 matrix.
create policy ticket_messages_select on ticket_messages for select to authenticated
  using (ticket_id in (select id from tickets));

create policy ticket_messages_staff_insert on ticket_messages for insert to authenticated
  with check (
    org_id = current_user_org_id()
    and author = 'staff'
    and author_id = auth.uid()
    and ticket_id in (select id from tickets)
  );

-- ── 2. What this sender was last talking about ─────────────────────────────
--
-- One row per sender per channel. Deliberately not a message log: it is the
-- minimum needed to decide whether the next message continues something or
-- starts something, and it expires.
create table chat_conversations (
  org_id     uuid not null references orgs(id) on delete cascade,
  channel    text not null,
  sender_ref text not null,

  last_ticket_id uuid references tickets(id) on delete set null,

  -- What we asked them, if anything. Lets a bare "yes" or "1" mean something
  -- without guessing.
  awaiting   text check (awaiting in ('urgency_confirmation')),

  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),

  primary key (org_id, channel, sender_ref)
);

alter table chat_conversations enable row level security;
-- No policy: this is webhook state, written by the service role and read by
-- nobody else. A tenant has no business knowing what another number was asked.

create index chat_conversations_expiry_idx on chat_conversations (expires_at);

-- ── 3. Where the AI's assessment came from ─────────────────────────────────
alter table tickets add column if not exists urgency_source text
  not null default 'ai' check (urgency_source in ('ai', 'reporter', 'staff'));
alter table tickets add column if not exists urgency_changed_at timestamptz;

comment on column tickets.urgency_source is
  'Who last set the priority. A reporter may correct the AI; they may not overrule a human who has since judged it — and the dashboard shows a self-declared urgency for what it is.';

-- ── Acting on a correction ─────────────────────────────────────────────────
--
-- Both functions are granted to the service role only: the webhooks hold that,
-- and an applicant/tenant never calls them directly. The sender reference is the
-- authority — it must match the ticket that message thread belongs to.
create or replace function set_ticket_urgency_by_reporter(
  p_org_id     uuid,
  p_ticket_id  uuid,
  p_sender_ref text,
  p_urgency    text
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
     and org_id = p_org_id
     -- The person correcting it must be the person who raised it. Without this,
     -- anyone who learned a ticket reference could re-prioritise someone else's.
     and channel_sender_ref = p_sender_ref
     and status not in ('resolved', 'closed')
   for update;

  if t.id is null then
    return false;
  end if;

  -- A human has since judged this. The reporter's opinion is recorded as a
  -- message but does not overwrite a decision an operator made deliberately.
  if t.urgency_source = 'staff' then
    insert into ticket_messages (org_id, ticket_id, author, channel, body)
    values (p_org_id, t.id, 'reporter', t.channel::text,
            format('Asked for priority %s (not applied — an operator had already set it).', p_urgency));
    return false;
  end if;

  update tickets
     set urgency = p_urgency::ticket_urgency,
         urgency_source = 'reporter',
         urgency_changed_at = now(),
         -- Someone telling us it is worse than we thought is exactly the case a
         -- person should look at. It also means a self-declared escalation can
         -- never quietly drive dispatch on its own.
         requires_human_review = case
           when p_urgency in ('critical', 'high') then true
           else requires_human_review
         end
   where id = t.id;

  insert into ticket_messages (org_id, ticket_id, author, channel, body)
  values (p_org_id, t.id, 'reporter', t.channel::text,
          format('Priority corrected by the reporter: %s → %s.', t.urgency, p_urgency));

  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (p_org_id, null, 'ticket.urgency_corrected_by_reporter', 'ticket', t.id,
          jsonb_build_object('urgency', t.urgency, 'source', t.urgency_source),
          jsonb_build_object('urgency', p_urgency, 'source', 'reporter'));

  return true;
end;
$$;

revoke all on function set_ticket_urgency_by_reporter(uuid, uuid, text, text) from public;
grant execute on function set_ticket_urgency_by_reporter(uuid, uuid, text, text) to service_role;

-- A follow-up appends to the thread instead of opening a second ticket.
create or replace function append_reporter_message(
  p_org_id     uuid,
  p_ticket_id  uuid,
  p_sender_ref text,
  p_body       text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  t tickets%rowtype;
begin
  select * into t from tickets
   where id = p_ticket_id
     and org_id = p_org_id
     and channel_sender_ref = p_sender_ref
     and status not in ('resolved', 'closed')
   for update;

  if t.id is null then
    return false;
  end if;

  insert into ticket_messages (org_id, ticket_id, author, channel, body)
  values (p_org_id, t.id, 'reporter', t.channel::text, p_body);

  -- A follow-up is new information on something already open; the person working
  -- it should see that it moved.
  update tickets set requires_human_review = true where id = t.id;

  return true;
end;
$$;

revoke all on function append_reporter_message(uuid, uuid, text, text) from public;
grant execute on function append_reporter_message(uuid, uuid, text, text) to service_role;

-- ── Conversation bookkeeping ───────────────────────────────────────────────
create or replace function remember_conversation(
  p_org_id     uuid,
  p_channel    text,
  p_sender_ref text,
  p_ticket_id  uuid,
  p_awaiting   text,
  p_hours      integer default 24
)
returns void language sql security definer set search_path = public as $$
  insert into chat_conversations (org_id, channel, sender_ref, last_ticket_id, awaiting, expires_at, updated_at)
  values (p_org_id, p_channel, p_sender_ref, p_ticket_id, p_awaiting,
          now() + make_interval(hours => p_hours), now())
  on conflict (org_id, channel, sender_ref) do update
     set last_ticket_id = excluded.last_ticket_id,
         awaiting       = excluded.awaiting,
         expires_at     = excluded.expires_at,
         updated_at     = now();
$$;

revoke all on function remember_conversation(uuid, text, text, uuid, text, integer) from public;
grant execute on function remember_conversation(uuid, text, text, uuid, text, integer) to service_role;

-- What the router needs to know about this sender, in one call. Returns nothing
-- once the window has passed, so a message weeks later starts fresh.
create or replace function conversation_context(
  p_org_id uuid, p_channel text, p_sender_ref text
)
returns table (
  ticket_id uuid, reference text, category text, urgency text,
  status text, awaiting text, message_text text, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select t.id, upper(left(replace(t.id::text, '-', ''), 8)),
         t.category::text, t.urgency::text, t.status::text,
         c.awaiting, t.message_text, t.created_at
    from chat_conversations c
    join tickets t on t.id = c.last_ticket_id
   where c.org_id = p_org_id
     and c.channel = p_channel
     and c.sender_ref = p_sender_ref
     and c.expires_at > now()
     and t.status not in ('resolved', 'closed');
$$;

revoke all on function conversation_context(uuid, text, text) from public;
grant execute on function conversation_context(uuid, text, text) to service_role;

comment on function conversation_context is
  'The one open thing this sender was last talking about, or nothing. Bounded by an expiry so an unrelated message weeks later is not read as a follow-up.';
