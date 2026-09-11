-- The WhatsApp number an org is REACHED ON, as opposed to the credential it is
-- routed by.
--
-- Why this is not read from `channel_routes`, which is where the WhatsApp
-- identity otherwise lives: since the 360dialog migration that table's
-- `external_id` is the per-channel WEBHOOK TOKEN — simultaneously the routing
-- key and the only proof an inbound POST is genuine, because direct 360dialog
-- clients receive no signature of any kind. 0039 therefore removed every policy
-- and grant on it (`revoke all ... from anon, authenticated`), so it is
-- service-role only and no UI can read it. That is correct and must stay that
-- way; it also means the table cannot answer "what number does a tenant tap to
-- reach this org," which is a public, non-secret fact about the brand.
--
-- So it belongs here, alongside the 0015 branding columns (`support_phone`,
-- `support_email`) it is a sibling of: admin-editable, org-scoped by the
-- existing `orgs_select` policy, and carrying no authority whatsoever. Leaking
-- it does nothing — it is printed on the brand's own signage. Leaking
-- `channel_routes.external_id` hands over inbound trust for the brand.
--
-- Stored in E.164 WITHOUT the leading '+' (e.g. '2347036891329'), because that
-- is the exact shape wa.me deep links require and normalising at read time in
-- three places invites the one place that forgets. `lib/whatsapp-link.ts`
-- normalises on the way in and refuses anything else.

alter table orgs add column if not exists whatsapp_number text;

comment on column orgs.whatsapp_number is
  'The org''s WhatsApp Business number in E.164 without the leading + (e.g. 2347036891329). Display and deep-link only — NOT a credential and NOT a routing key. Inbound routing uses channel_routes.external_id (the webhook token, service-role only, see 0039); this column exists so the portal can build a wa.me link without touching that table.';

-- A stored value ends up inside a URL the portal hands to a user, so constrain
-- it to digits at the boundary rather than trusting every future caller to
-- sanitise. 7–15 digits is E.164's own range.
alter table orgs drop constraint if exists orgs_whatsapp_number_e164;
alter table orgs add constraint orgs_whatsapp_number_e164
  check (whatsapp_number is null or whatsapp_number ~ '^[1-9][0-9]{6,14}$');
