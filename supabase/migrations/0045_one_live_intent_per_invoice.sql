-- One live payment request per invoice — enforced, not merely intended.
--
-- `raisePaymentRequest` checks for an existing pending/part_paid intent before
-- inserting one, and its comment says two checkout links for the same charge
-- "invites paying twice". But a read followed by an insert is not atomic: two
-- staff acting at once, or one impatient double-click, can both find nothing and
-- both insert. The result is exactly what the check exists to prevent — two live
-- Paystack links for one invoice, each payable.
--
-- The application check stays (it returns the existing link, which is the useful
-- behaviour). This makes the guarantee real underneath it.
--
-- Deliberately PARTIAL: an invoice may accumulate any number of failed or
-- cancelled attempts, and a paid one is settled. Only the LIVE states are
-- constrained.

create unique index if not exists payment_intents_one_live_per_charge_uidx
  on payment_intents (service_charge_id)
  where service_charge_id is not null
    and status in ('pending', 'part_paid');

comment on index payment_intents_one_live_per_charge_uidx is
  'At most one pending/part_paid intent per service charge. Backs the read-then-insert guard in raisePaymentRequest, which cannot be atomic on its own.';
