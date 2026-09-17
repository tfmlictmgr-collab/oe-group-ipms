-- Inbound chat webhooks had no idempotency guard — unlike the payments webhook,
-- which has had one since day one (`gateway_events`, 0032): "a retry after a
-- timeout is normal traffic" applies here exactly as much as it does to money.
--
-- Observed live, 2026-08-05: a WhatsApp user sent "Hi" once and received the
-- identical "Hello, you have X open — tell us more..." pleasantry reply SIX
-- times over many hours (00:00, 06:14, 18:38, 19:06 x2, 19:32 x2). WhatsApp
-- (via 360dialog) and Telegram both redeliver a webhook on any slow or
-- non-2xx response, with an escalating backoff that can span hours — and
-- nothing here recognised "I have already answered this exact message."
-- Every redelivery was reprocessed as if new, deterministically producing the
-- same reply again.
--
-- Fixed the same way 0032 fixed it for money: record the provider's own event
-- id before doing any work, let the unique index reject a redelivery, and
-- treat that as "already handled" rather than reprocessing.
create table chat_webhook_events (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp', 'telegram')),
  -- WhatsApp: the message's own id (`messages[0].id`, the wamid) — stable
  -- across every redelivery of that same message. Telegram: the update's own
  -- `update_id`, which covers a tapped button the same way it covers a
  -- message, from one bot.
  event_id text not null,
  org_id uuid references orgs(id),
  sender_ref text,
  received_at timestamptz not null default now()
);

create unique index chat_webhook_events_dedupe_uidx on chat_webhook_events (channel, event_id);

alter table chat_webhook_events enable row level security;

-- No select policy, deliberately — same reasoning as channel_routes (0039):
-- nothing in the UI reads this table, so granting no client role any access is
-- the strongest correct answer, not an oversight. Written and read only by the
-- webhook handlers under the service role, which bypasses RLS.
