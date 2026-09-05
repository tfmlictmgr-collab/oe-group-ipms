-- A receipt needs somewhere to go (decision 33, 5 Sept 2026).
--
-- Reported as "client fund payment receipt didn't get to the recipient's
-- email." Traced, there were two separate reasons for that, and only the first
-- is the one anybody would guess.
--
--   1. Nothing was ever sent. The collections webhook verifies the payment,
--      posts it to the ledger and returns 200. There is no `sendEmail` call on
--      that path and never has been. The only receipt in the product is a PDF
--      rendered on demand at `/api/receipts/[intentId]`, which requires a
--      signed-in session and is linked from inside the dashboard — so a tenant
--      who paid a link and holds no portal account had no route to it at all.
--      (`lib/guides/processes.ts` told them a verified payment "issues a
--      receipt in real time"; it meant "makes one downloadable".)
--
--   2. ⚠️ And once a send was added, half the collections still had nowhere to
--      send it. `raisePaymentRequest` resolves a `receiptEmail` — carefully,
--      with a deliverability check and a helpful refusal — hands it to the
--      gateway, and then DISCARDS IT. `payment_intents` has no email column.
--      For a collection against a portal user the address can be recovered
--      from `users`, but the Collections screen raises plenty against
--      "Unassigned" — a unit with no tenant account — and there the address the
--      person typed at checkout was the only one that ever existed.
--
-- So the address is kept. It is the address the receipt is owed to, and
-- throwing it away made the receipt unsendable for exactly the payers least
-- able to go and find one.
--
-- 📌 The shape is decision 24's again: `raisePaymentRequest` was written when
-- the gateway's own confirmation email was the whole story, and stayed correct
-- for that while silently becoming insufficient for ours.

alter table payment_intents
  add column if not exists payer_email text;

comment on column payment_intents.payer_email is
  'The address checkout was raised against, kept so a receipt can be sent to a payer who has no portal account (0253).';

-- Backfilled from the payer's own record where there is one. Deliberately not
-- guessed anywhere else: an intent raised for an unassigned unit before today
-- has no address recorded anywhere, and inventing one would send somebody
-- else's receipt to whoever happens to be nearest in the data.
update payment_intents pi
   set payer_email = u.email
  from users u
 where u.id = pi.payer_user_id
   and pi.payer_email is null
   and u.email is not null;
