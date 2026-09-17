-- Per-org sender identity.
--
-- A single RESEND_FROM environment variable was wrong for a two-brand system:
--
--   1. OE Group is the holding entity and is NOT client-facing (B1). A tenant of
--      a TFML-managed property who receives mail from "OE Group" either doesn't
--      recognise the sender or reads it as phishing — and it leaks the group
--      structure that the isolation rule says they should never see.
--   2. The address itself must differ per brand anyway, because each brand sends
--      from its own verified subdomain (notify.tfmlconsultant.com vs
--      notify.oraegbunike.com). One env var cannot express that.
--
-- So the sender identity belongs on the org, next to the reply addresses, and
-- stays admin-editable so a rebrand needs no deploy.

alter table orgs add column if not exists email_from_name    text;
alter table orgs add column if not exists email_from_address text;

comment on column orgs.email_from_name is
  'Display name recipients see, e.g. "TFML Nigeria". Must be the client-facing brand, never the holding entity.';
comment on column orgs.email_from_address is
  'Envelope/From address. Must sit on a domain verified with the email provider for this brand.';
