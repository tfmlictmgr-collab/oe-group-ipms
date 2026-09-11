-- A tenant can see their own tenancy.
--
-- ⚠️ Found because a suite assertion passed on zero rows. The check said "none
-- of the rows the tenant can see belong to anyone else", which is trivially
-- true when they can see nothing at all — so it reported PASS while the tenant
-- had no access to their own lease.
--
-- 📌 **A "no bad rows" assertion is not a test until it also asserts there are
-- rows.** This is the second time that shape has hidden something in this build.
--
-- The cause: `rent_roll` is `security_invoker` and joins `properties` and
-- `units`, and since `0056` a tenant has read on neither — `properties_select`
-- wants `properties.read_all` or a stakeholder assignment, and a tenant is an
-- occupant, not a stakeholder. The join produced nothing.
--
-- Fixed the way `0003` already established for tenants: they read a
-- denormalised, definer-scoped result rather than being granted access to the
-- property register. Widening `properties_select` to admit occupants would give
-- every tenant a read on the property table itself, which is a much larger
-- grant than "show me my flat".
create or replace function my_tenancies()
returns table (
  lease_id uuid,
  property_name text,
  unit_label text,
  status lease_status,
  start_date date,
  end_date date,
  days_to_expiry integer,
  rent_amount numeric,
  rent_frequency rent_frequency,
  currency text,
  rent_billed numeric,
  rent_paid numeric,
  rent_outstanding numeric
)
language sql stable security definer set search_path = public as $$
  select
    l.id, p.name, u.label, l.status, l.start_date, l.end_date,
    (l.end_date - current_date)::integer,
    l.rent_amount, l.rent_frequency, l.currency,
    coalesce(c.billed, 0),
    coalesce(c.paid, 0),
    coalesce(c.billed, 0) - coalesce(c.paid, 0)
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join lateral (
    select sum(rc.amount) as billed, sum(rc.amount_paid) as paid
      from rent_charges rc where rc.lease_id = l.id
  ) c on true
  -- The whole boundary, in one line: this function is SECURITY DEFINER, so its
  -- WHERE clause is the only thing standing between a caller and every tenancy
  -- in the database.
  where l.tenant_user_id = auth.uid()
    and l.deleted_at is null;
$$;

revoke all on function my_tenancies() from public;
grant execute on function my_tenancies() to authenticated;

comment on function my_tenancies is
  'The caller''s own tenancies, with the property and unit labels denormalised. Definer-scoped to auth.uid() because a tenant has no read on the property register — and should not need one to see their own flat.';
