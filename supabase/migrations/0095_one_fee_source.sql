-- One number, one home.
--
-- Two places still claimed to know the management fee:
--   • `payment_settings.management_fee_percent` / `admin_fee_percent` (0027),
--     read by `create_landlord_remittance` for rent recorded outside the
--     rent_charges model, and edited on Settings → Payment Gate.
--   • `orgs.management_fee_pct` / `admin_fee_flat` (0090, decision 14), edited
--     on Settings → Lettings and snapshotted onto every rent demand.
--
-- An administrator could set 10% on one screen and 7% on the other and be right
-- both times, with no indication the two existed. Whichever path a given piece
-- of rent took would then decide what the landlord was paid.
--
-- 0092b flagged this and deliberately did not merge them, because merging
-- changes what an existing manual remittance deducts. That reason has now
-- expired: nothing in this database has a manual landlord remittance, so the
-- safe moment to consolidate is now, before one exists.
--
-- **`orgs` wins**, because decision 14 is the board's model and the snapshot
-- already derives from it. `payment_settings` keeps its columns — dropping them
-- would break `create_landlord_remittance` mid-flight — but they are now fed
-- FROM `orgs` rather than edited independently.

-- Carry across anything an org already had, so nobody's configured rate is lost
-- to the consolidation. Only where `orgs` is still at its default, so a rate
-- deliberately set on the Lettings screen is never overwritten by an older one.
update orgs o
   set management_fee_pct = ps.management_fee_percent
  from payment_settings ps
 where ps.org_id = o.id
   and o.management_fee_pct = 10.000
   and ps.management_fee_percent is not null
   and ps.management_fee_percent <> 0
   and ps.management_fee_percent <> 10.000;

-- ── Keep them in step from here on ────────────────────────────────────────
--
-- A trigger rather than a rewrite of `create_landlord_remittance`: that function
-- is exercised by the remittance suite and by the vendor path, and changing what
-- it reads is a larger blast radius than making what it reads correct.
create or replace function sync_payment_settings_fee()
returns trigger language plpgsql set search_path = public as $$
begin
  update payment_settings
     set management_fee_percent = new.management_fee_pct
   where org_id = new.id
     and management_fee_percent is distinct from new.management_fee_pct;
  return null;
end;
$$;

create trigger orgs_fee_syncs_payment_settings
  after update of management_fee_pct on orgs
  for each row execute function sync_payment_settings_fee();

comment on function sync_payment_settings_fee is
  'Keeps the legacy payment_settings fee in step with orgs.management_fee_pct (decision 14), so the two cannot disagree about what a landlord is owed. orgs is the source; payment_settings is a mirror kept only because create_landlord_remittance still reads it.';

-- Backfill the mirror once, so it starts in step rather than in step from the
-- next edit onwards.
update payment_settings ps
   set management_fee_percent = o.management_fee_pct
  from orgs o
 where o.id = ps.org_id
   and ps.management_fee_percent is distinct from o.management_fee_pct;

comment on column payment_settings.management_fee_percent is
  'MIRROR of orgs.management_fee_pct — do not edit directly. Kept because create_landlord_remittance reads it for rent recorded outside the rent_charges model. The board''s model (decision 14) lives on orgs.';
