-- The Telegram bot username an org is REACHED ON — the sibling of 0146, and
-- the same distinction, which for Telegram is sharper still.
--
-- A bot has two identifiers:
--
--   username  '@tfml_support_bot'. Public by construction — Telegram shows it
--             to everyone who has ever messaged the bot, and it is searchable.
--             It grants nothing. This column.
--   token     the bot's entire authority. It lives in `channel_routes` and 0039
--             removed every policy and grant on that table precisely because a
--             tenant could read it: "Anyone holding it can forge inbound
--             service requests against the org, choose which org they land in,
--             and attribute them to any sender."
--
-- Putting the username here keeps those two apart. The portal can render a
-- "Chat on Telegram" link from an org-scoped, user-readable row without any UI
-- ever selecting from the credential table — which 0039's comment explicitly
-- forbids adding a policy to.
--
-- Nothing is registered in this column yet, and that is expected: the TFML and
-- OEA bots are still uncreated in @BotFather (GO_LIVE_CHECKLIST.md §1). The
-- column existing first means bringing them online is a settings entry, not a
-- deploy.

alter table orgs add column if not exists telegram_bot_username text;

comment on column orgs.telegram_bot_username is
  'The org''s Telegram bot username, WITHOUT the leading @ (e.g. tfml_support_bot). Public and non-authoritative — it is the handle people already see in the chat. The bot TOKEN is a credential and lives in channel_routes, service-role only (see 0039). Never store a token here.';

-- Telegram's own constraints: 5-32 chars, letters/digits/underscore, and a bot
-- username must end in 'bot'. Enforced in the database as well as in
-- `lib/telegram-link.ts` because the likeliest bad value is not an attack but a
-- mistake — an admin pasting a personal @handle — and that would silently point
-- every "chat with us" link in the portal at a stranger.
alter table orgs drop constraint if exists orgs_telegram_bot_username_shape;
alter table orgs add constraint orgs_telegram_bot_username_shape
  check (
    telegram_bot_username is null
    or telegram_bot_username ~ '^[A-Za-z0-9_]{5,32}$' and telegram_bot_username ~* 'bot$'
  );
