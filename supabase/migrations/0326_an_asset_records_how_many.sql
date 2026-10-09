-- An asset records how many (requested 9 Oct 2026).
--
-- "Twelve office chairs" or "four split units" was one register row with the
-- count in the name or the notes, where nothing could add it up. `quantity` is
-- the count of identical items the row stands for.
--
-- ⚠️ Deliberately NOT what 0198/0200 decided for units. A UNIT is a thing a
-- person occupies, a lease points at and an invoice bills, so every consumer
-- needs an identifiable row and `create_units` makes one per unit. An asset
-- row for a batch of identical chairs has no such consumer: nobody leases a
-- chair. Plant that is serviced, metered or certified individually (a
-- generator, a lift) should still be its own row with its own tag, and the
-- form says so.
--
-- Whole numbers, at least one. Existing rows read 1, which is what each of them
-- has always meant.

alter table assets
  add column if not exists quantity integer not null default 1;

alter table assets drop constraint if exists assets_quantity_positive;
alter table assets
  add constraint assets_quantity_positive check (quantity between 1 and 1000000);

comment on column assets.quantity is
  'How many identical items this register row stands for (default 1). Plant serviced or certified individually belongs on its own row. 0326.';

do $$
begin
  if exists (select 1 from assets where quantity is distinct from 1) then
    raise exception '0326: existing assets should all read quantity 1';
  end if;
end $$;
