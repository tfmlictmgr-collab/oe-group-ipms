-- The two enum values an FM/PM ops requisition needs, added on their own.
--
-- `ALTER TYPE ... ADD VALUE` cannot be USED in the transaction that adds it,
-- and the migration runner wraps each file in one — the split 0037, 0071 and
-- 0150 all used, and the same one here.
--
--   payout_party gains 'other'          — a payee who is neither a registered
--                                          vendor nor a landlord: a one-off
--                                          supplier, or an ops staff member
--                                          reimbursed for their own outlay.
--   ledger_account_purpose gains
--   'requisition_payable'                — mirrors 'vendor_payable'. An ops
--                                          requisition draws against the SAME
--                                          service-charge fund a vendor
--                                          invoice already does; there is no
--                                          separate "operating account" in
--                                          this chart, and inventing one is a
--                                          materially larger piece of work
--                                          than this feature asked for.

alter type payout_party add value if not exists 'other';
alter type ledger_account_purpose add value if not exists 'requisition_payable';
