-- Per-category reply addresses.
--
-- Outbound mail is sent From a dedicated subdomain (notify.<brand>) to protect
-- the root domain's sending reputation, but that subdomain is not a mailbox.
-- Replies are therefore routed by Reply-To to real, monitored inboxes.
--
-- These are per-ORG, not environment variables, because TFML and OEA have
-- different teams and different inboxes — and an org admin must be able to
-- change them without a deploy. `support_email` already exists (0015); this
-- adds the two other routes the system needs.
--
--   support  — invitations, account, vendor applications      (exists)
--   finance  — invoices, statements, remittance advice        (Day 5-6)
--   it       — system/technical notices to the operator       (not yet wired)
--
-- All optional: an unset category falls back to support_email, and if that is
-- unset too, the email simply carries no Reply-To rather than a broken one.

alter table orgs add column if not exists finance_email text;
alter table orgs add column if not exists it_email      text;
