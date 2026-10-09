-- 📌 9 Oct 2026. The chart gains a place for money that is paid but not yet settled.
--
-- An online payment reaches the organisation's Paystack (or Flutterwave)
-- balance first, and the bank only when the gateway settles — usually the next
-- business day, net of the gateway's fee. Until 0320 every online collection was
-- posted straight to the client-funds BANK account, so the ledger said the bank
-- held money that was still at the gateway and the reconciliation showed a
-- difference nobody could explain on the day. 0320 posts it here instead.
--
-- Its own file because Postgres cannot use a new enum value in the transaction
-- that adds it, and migrate.mjs runs each file in one transaction.

alter type ledger_account_purpose add value if not exists 'gateway_clearing';

alter table ledger_accounts add column if not exists gateway text;
alter table ledger_accounts drop constraint if exists ledger_accounts_gateway_known;
alter table ledger_accounts add constraint ledger_accounts_gateway_known
  check (gateway is null or gateway in ('paystack', 'flutterwave'));

comment on column ledger_accounts.gateway is
  'For a gateway_clearing account: which gateway''s balance it mirrors. Null for every other account. 0319.';
