-- An Owner Rep: third-party oversight on a property owner's behalf (requested
-- 9 Oct 2026). Two enum values, and nothing that uses them.
--
-- ⚠️ ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds it,
-- and scripts/migrate.mjs wraps each file in one — the split 0182/0183 and
-- 0306/0307 already made. On its own this file grants nothing: no function,
-- policy or capability names either value until 0327.
--
-- `representative` is a RELATION, not only a role, on purpose. Attaching an
-- Owner Rep to a property as `owner` would make every reader that asks "who
-- owns this building" — `tenancy_schedule`'s landlord column,
-- `report_collections`, `property_landlord()`, `landlord_statement()` and every
-- owner-addressed notice — name them as the landlord and hand them the
-- landlord's money. A distinct relation keeps those readers right without
-- touching one of them.

alter type user_role add value if not exists 'owner_representative';
alter type property_relation add value if not exists 'representative';
