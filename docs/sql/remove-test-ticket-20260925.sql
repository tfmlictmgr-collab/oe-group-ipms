-- Remove the one test ticket production holds, 26 Sept 2026.
--
-- Found by the 4.5 restore drill: both 26 Sept backups carried `tickets = 1`,
-- where 24 Sept's emptiness proof read 0. It is the operator's own test message,
-- sent to OEA's WhatsApp number on 25 Sept 08:26 UTC while live updates were
-- being fixed: "Leaking kitchen tap at Flat 2, water on the floor…". A
-- realistic request, so it opened a real ticket. The external pen test (1.11 /
-- 6.2) needs an empty production.
--
-- Run in the PRODUCTION SQL editor (civwriqvghvyqtfrzftu in the address bar),
-- one part at a time.

-- ── Part 1 — look first (reads only) ─────────────────────────────────────
-- What the ticket drags with it. `payments`, `requisitions` and `evaluations`
-- must be 0 — those would block the delete, and should never exist for a test.
select t.id, o.slug, t.channel, t.status, t.created_at,
       (select count(*) from ticket_messages m where m.ticket_id = t.id)       as messages,
       (select count(*) from ticket_attachments a where a.ticket_id = t.id)    as attachments,
       (select count(*) from user_notifications n where n.entity_id = t.id)    as notifications,
       (select count(*) from chat_conversations c where c.last_ticket_id = t.id) as conversations_pointing,
       (select count(*) from payments p where p.ticket_id = t.id)              as payments,
       (select count(*) from ops_requisitions r where r.ticket_id = t.id)      as requisitions,
       (select count(*) from vendor_evaluations v where v.ticket_id = t.id)    as evaluations
  from tickets t join orgs o on o.id = t.org_id;

-- ── Part 2 — remove it (one atomic block) ────────────────────────────────
-- Refuses unless production holds exactly this one ticket and nothing with
-- money or a vendor's record points at it. Its messages and attachments go by
-- cascade, its notifications by trigger (delete_notifications_for_deleted_entity),
-- and the chat conversation's pointer is cleared (ON DELETE SET NULL).
do $$
declare
  v_id uuid;
  v_all bigint;
begin
  select count(*) into v_all from tickets;
  if v_all <> 1 then
    raise exception 'Expected exactly ONE ticket in production, found %. Stop and look.', v_all;
  end if;

  select id into v_id from tickets
   where created_at = '2026-09-25 08:26:16.322322+00'
     and message_text like 'Leaking kitchen tap at Flat 2%';
  if v_id is null then
    raise exception 'The one ticket is not the 25 Sept test ticket. Nothing deleted.';
  end if;

  if exists (select 1 from payments where ticket_id = v_id)
     or exists (select 1 from ops_requisitions where ticket_id = v_id)
     or exists (select 1 from vendor_evaluations where ticket_id = v_id) then
    raise exception 'Money, a requisition or a vendor evaluation points at this ticket. Nothing deleted.';
  end if;

  delete from tickets where id = v_id;
end $$;

-- ── Part 3 — prove it (reads only) ───────────────────────────────────────
-- Every line must read 0.
select 'tickets' as what, count(*) as n from tickets
union all select 'ticket_messages', count(*) from ticket_messages
union all select 'ticket_attachments', count(*) from ticket_attachments
union all select 'ticket notifications', count(*) from user_notifications where entity_type = 'ticket'
union all select 'conversations pointing at a ticket', count(*) from chat_conversations where last_ticket_id is not null;

-- ── Part 4 — who has messaged production at all? (reads only) ─────────────
-- The WhatsApp and Telegram numbers are the REAL business numbers since 25
-- Sept. A greeting opens no ticket, so a customer who has already written in
-- would not show above. Counts only: no numbers are displayed.
select o.slug, e.channel,
       count(*)                     as messages,
       count(distinct e.sender_ref) as distinct_senders,
       min(e.received_at)           as first,
       max(e.received_at)           as last
  from chat_webhook_events e left join orgs o on o.id = e.org_id
 group by 1, 2 order by 1, 2;
