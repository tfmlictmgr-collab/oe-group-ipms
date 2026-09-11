-- One Telegram bot per brand, and a reply that leaves from the right one.
--
-- Inbound already routes per-bot: the secret token Telegram echoes on every
-- webhook IS the routing key (0011), so a message reaches the correct org. But
-- OUTBOUND used a single `TELEGRAM_BOT_TOKEN` environment variable — exactly the
-- fault WhatsApp had, where a person who wrote to OEA got their answer from the
-- TFML number. With one bot it was invisible; with two it means every reply
-- comes from whichever bot that variable happens to name.
--
-- The bot token therefore belongs beside the route, not in the environment.
-- `channel_routes` has been service-role-only since 0039 precisely because
-- `external_id` is already a credential for Telegram, so this column is stored
-- under the same protection rather than needing new machinery.
--
-- WhatsApp does not need this: Meta issues one System User token per business
-- covering every number under it, so there the token is shared and only the
-- phone_number_id differs. Telegram issues a token per bot. The column is
-- nullable for that reason.

alter table channel_routes add column if not exists outbound_token text;

comment on column channel_routes.outbound_token is
  'CREDENTIAL. The bot token replies are sent with, for channels that issue one per identity (Telegram). Null where the channel shares one token across identities (WhatsApp). Service-role only — see 0039.';

-- Reads the sending credential for an org's channel. Deliberately a function
-- rather than a view: it is the only thing that should ever return this column,
-- and keeping it in one place makes that reviewable.
--
-- Ordered, not merely limited: an org may hold more than one bot (a migration
-- in progress, a second line), and `limit 1` with no ORDER BY would let the
-- planner decide which brand's identity a message goes out from. That exact
-- defect has been fixed four separate times in this build.
create or replace function channel_sender_for_org(
  p_org_id uuid,
  p_channel text
)
returns table (external_id text, outbound_token text)
language sql stable security definer set search_path = public as $$
  select r.external_id, r.outbound_token
    from channel_routes r
   where r.org_id = p_org_id
     and r.channel = p_channel
   order by r.created_at, r.external_id
   limit 1;
$$;

revoke all on function channel_sender_for_org(uuid, text) from public, anon, authenticated;
grant execute on function channel_sender_for_org(uuid, text) to service_role;

comment on function channel_sender_for_org(uuid, text) is
  'The identity an org sends FROM on a channel. Service-role only: it returns a credential.';
