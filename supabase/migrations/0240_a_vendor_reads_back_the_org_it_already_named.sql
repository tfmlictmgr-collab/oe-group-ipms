-- The vendor's own list of introductions it has offered — the missing UI half
-- of 0165. `offer_vendor_introduction`, `withdraw_vendor_introduction`,
-- `accept_vendor_introduction` and `decline_vendor_introduction` have existed
-- since 0165; nothing in the product ever called the first two, and the
-- `notify_role` link the staff-side offer sends
-- (`/dashboard/vendors/introductions`) pointed at a page that did not exist.
-- `manage_contracts` (decision 17) has been a real, granted capability with
-- nothing behind it.
--
-- ⚠️ This is NOT the redaction 0165 built. That function
-- (`pending_vendor_introductions`) hides the SOURCE org from the RECEIVING
-- org — the crossing decision 12 requires a board exception for. Here the
-- reader IS the source: a vendor reading back the name of the org THEY
-- THEMSELVES typed the slug for is not a new disclosure, it is showing them
-- their own input. Same precedent as 0165's header — one audited function,
-- never a cross-org policy — applied to the other direction of the same
-- table.
create or replace function my_vendor_introductions()
returns table (
  id uuid,
  target_org_name text,
  target_org_slug text,
  status vendor_introduction_status,
  consented_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz,
  decision_notes text
)
language sql stable security definer set search_path = public as $$
  select i.id, o.name, o.slug, i.status, i.consented_at, i.expires_at,
         i.decided_at, i.decision_notes
    from vendor_introductions i
    join orgs o on o.id = i.target_org_id
   where i.source_vendor_id in (select current_user_vendor_ids())
   order by i.consented_at desc;
$$;

revoke all on function my_vendor_introductions() from public, anon;
grant execute on function my_vendor_introductions() to authenticated;

comment on function my_vendor_introductions is
  'A vendor''s own consent history, with the target organisation named — safe because the reader already supplied that slug when offering (0165). The redacted, name-withheld direction is pending_vendor_introductions(), read by the RECEIVING org, which must not learn the source.';
