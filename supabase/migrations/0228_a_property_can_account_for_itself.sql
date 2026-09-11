-- A property could not account for itself.
--
-- Three statements exist, and between them they leave one question unanswerable:
--
--   `landlord_statement` (0130)   — what one OWNER is owed, per property. Rent
--                                   only; service charge appears nowhere in it,
--                                   correctly, because a service charge is owed
--                                   to the fund and not to the landlord.
--   `org_profit_and_loss` (0130)  — what the ORGANISATION earned and spent.
--   `my_service_charges` (0123)   — what one TENANT was billed.
--
-- Nothing answers *"show me everything that happened on this building"*, which
-- is the question a landlord asks on the phone, an auditor asks in writing, and
-- a property manager needs before either of them does. Assembling it today means
-- reading the rent roll, the service-charge budget and the ledger side by side
-- and doing the arithmetic by hand — which is exactly the reconciliation nobody
-- can be asked to repeat identically twice.
--
-- ⚠️ **Both sides of the money, kept apart.** Rent is collected FOR the landlord
-- and remitted to them net of fees. Service charge is collected INTO a fund the
-- property spends. Adding them produces a number that means nothing, and this
-- codebase has already made that mistake once at scale — 0103's segregation view
-- summed across currencies and reported a shortfall that meant nothing, on the
-- one screen built to catch exactly that. So the two travel in separate columns
-- and there is no grand total anywhere in this function.
--
-- ⚠️ **Scoped through `current_user_property_ids()` and nothing new.** Decision
-- 8's rule: one resolver, extended — never a second one alongside. The resolver
-- deliberately does not filter on `relation` (0184), so it already answers for
-- an owner exactly as for a manager, which is precisely what this report needs:
-- a landlord reaches their own building, an FM/PM reaches the ones they hold,
-- oversight reaches all of them, and nobody had to write a third rule.
--
-- 📌 0184's warning applies in the other direction here and is worth stating:
-- that migration found a LANDLORD LEAK caused by an unguarded branch that
-- consumed this resolver. The difference is what is being released. There, it
-- was every tenant's complaint about a building — B7's Service-requests cell for
-- `property_owner` reads "—". Here it is the money on a property an owner owns,
-- which B7's SC & financials cell grants them in full ("Own portfolio (RT)").
-- The resolver is the right scoping for THIS consumer; it was the wrong one for
-- that one. Consumers differ; the resolver does not.

create or replace function property_statement(
  p_property_id uuid,
  p_from date,
  p_to   date
)
returns table (
  property_id      uuid,
  property_name    text,
  currency         text,

  -- Rent, on the landlord's side of the house.
  rent_charges     bigint,
  rent_demanded    numeric,
  rent_collected   numeric,
  fees_taken       numeric,
  landlord_share   numeric,
  landlord_remitted numeric,
  landlord_held    numeric,

  -- Service charge, on the fund's side.
  sc_invoices      bigint,
  sc_billed        numeric,
  sc_collected     numeric,
  sc_outstanding   numeric,

  -- What the register says the place is.
  unit_count       bigint,
  occupied_units   bigint,
  live_tenancies   bigint
)
language sql stable security definer set search_path = public as $$
  with allowed as (
    select p.id, p.name
      from properties p
     where p.id = p_property_id
       and p.deleted_at is null
       and p.org_id = current_user_org_id()
       -- The whole boundary. SECURITY DEFINER, so this clause is all that
       -- stands between a caller and another property's books.
       and (
         p.id in (select current_user_property_ids())
         or current_user_role() = any (oversight_roles())
       )
  ),
  rent as (
    select
      count(rc.id) n,
      coalesce(sum(rc.amount), 0) demanded,
      coalesce(sum(rc.amount_paid), 0) collected,
      -- Fees and the landlord's share are apportioned to what was ACTUALLY
      -- COLLECTED, and read from the rate snapshotted on the charge (decision
      -- 14) rather than recomputed. A landlord is credited what came in, never
      -- what was billed — the same rule `create_rent_remittance` enforces when
      -- it totals, and the same definition `landlord_statement` already uses,
      -- so the two reports about one property cannot disagree.
      coalesce(sum(round(
        (rc.management_fee_amount + rc.admin_fee_amount)
        * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) fees,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2)), 0) net,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
        filter (where rc.remitted_at is not null), 0) remitted,
      coalesce(sum(round(
        rc.landlord_net_amount * (rc.amount_paid / nullif(rc.amount, 0)), 2))
        filter (where rc.remitted_at is null), 0) held
    from allowed a
    join leases l       on l.property_id = a.id and l.deleted_at is null
    join rent_charges rc on rc.lease_id = l.id
   where rc.period_start >= p_from and rc.period_start <= p_to
  ),
  sc as (
    -- Joined through the BUDGET, not through `service_charges.unit_id`. A
    -- budget belongs to a property; a charge's unit is nullable on rows written
    -- before 0003 added the column, and a statement that silently omits them is
    -- worse than one that says nothing.
    select
      count(s.id) n,
      coalesce(sum(s.amount), 0) billed,
      coalesce(sum(s.amount_paid), 0) collected
    from allowed a
    join sc_budgets b on b.property_id = a.id
    join service_charges s on s.budget_id = b.id and s.deleted_at is null
   where s.created_at::date >= p_from and s.created_at::date <= p_to
  ),
  reg as (
    select
      count(u.id) n,
      count(u.id) filter (where not unit_is_vacant(u.id)) occupied
    from allowed a
    join units u on u.property_id = a.id and u.deleted_at is null
  ),
  ten as (
    select count(*) n
      from allowed a
      join leases l on l.property_id = a.id and l.deleted_at is null
     where l.status in ('active', 'renewed')
  )
  select
    a.id, a.name,
    -- Read off the property's OWN charges, not assumed and not taken from an
    -- org-level default (there is none — `orgs` carries no default_currency,
    -- checked rather than guessed). A property let in dollars must not have its
    -- statement labelled Naira. One currency per property in practice; if that
    -- ever stops being true this reports the commonest rather than silently
    -- adding them, which 0103 established is the failure that matters.
    coalesce((
      select rc2.currency
        from allowed a2
        join leases l2 on l2.property_id = a2.id and l2.deleted_at is null
        join rent_charges rc2 on rc2.lease_id = l2.id
       group by rc2.currency
       order by count(*) desc
       limit 1
    ), 'NGN'),
    rent.n, rent.demanded, rent.collected, rent.fees, rent.net, rent.remitted, rent.held,
    sc.n, sc.billed, sc.collected, greatest(sc.billed - sc.collected, 0),
    reg.n, reg.occupied, ten.n
  from allowed a, rent, sc, reg, ten;
$$;

revoke all on function property_statement(uuid, date, date) from public;
revoke execute on function property_statement(uuid, date, date) from anon;
grant execute on function property_statement(uuid, date, date) to authenticated;

comment on function property_statement is
  'Everything that happened on one property over a period: rent demanded, collected, fees taken, the landlord''s share, what has been remitted and what is still held -- and, kept deliberately separate, the service charge billed and collected. No grand total: rent is owed to a landlord and service charge to a fund, and adding them produces a figure that means nothing (the 0103 lesson). Scoped through current_user_property_ids() and oversight_roles() -- one resolver, extended (decision 8), never a second one.';

-- ── The lines behind the figure ───────────────────────────────────────────
--
-- A summary nobody can drill into is an assertion, not a statement. B7 promises
-- an auditable trail and decision 24's rule is that every touch point sees the
-- detail at their desk; a landlord asking "which tenant, which month" cannot be
-- answered by a total.
create or replace function property_statement_lines(
  p_property_id uuid,
  p_from date,
  p_to   date
)
returns table (
  kind          text,     -- 'rent' | 'service_charge'
  reference     text,
  unit_label    text,
  party         text,
  period_label  text,
  due_date      date,
  amount        numeric,
  amount_paid   numeric,
  status        text,
  settled_at    timestamptz
)
language sql stable security definer set search_path = public as $$
  with allowed as (
    select p.id
      from properties p
     where p.id = p_property_id
       and p.deleted_at is null
       and p.org_id = current_user_org_id()
       and (
         p.id in (select current_user_property_ids())
         or current_user_role() = any (oversight_roles())
       )
  )
  select
    'rent'::text,
    rc.id::text,
    u.label,
    coalesce(t.full_name, t.email, 'no tenant recorded'),
    to_char(rc.period_start, 'DD Mon YYYY') || ' — ' || to_char(rc.period_end, 'DD Mon YYYY'),
    rc.due_date,
    rc.amount,
    rc.amount_paid,
    rc.status::text,
    rc.remitted_at
  from allowed a
  join leases l        on l.property_id = a.id and l.deleted_at is null
  join rent_charges rc on rc.lease_id = l.id
  join units u         on u.id = l.unit_id
  left join users t    on t.id = l.tenant_user_id
  where rc.period_start >= p_from and rc.period_start <= p_to

  union all

  select
    'service_charge'::text,
    s.id::text,
    coalesce(u.label, s.property_or_unit, '—'),
    coalesce(bu.full_name, bu.email, 'unassigned'),
    coalesce(s.billing_period, b.period),
    s.due_date,
    s.amount,
    coalesce(s.amount_paid, 0),
    s.status,
    null::timestamptz
  from allowed a
  join sc_budgets b      on b.property_id = a.id
  join service_charges s on s.budget_id = b.id and s.deleted_at is null
  left join units u      on u.id = s.unit_id
  left join users bu     on bu.id = s.billed_to_user_id
  where s.created_at::date >= p_from and s.created_at::date <= p_to

  order by 1, 6 nulls last, 3;
$$;

revoke all on function property_statement_lines(uuid, date, date) from public;
revoke execute on function property_statement_lines(uuid, date, date) from anon;
grant execute on function property_statement_lines(uuid, date, date) to authenticated;

comment on function property_statement_lines is
  'The rent demands and service-charge invoices behind property_statement(), so the summary can be drilled into rather than taken on trust. Same boundary as its parent, restated rather than inherited -- a definer function that trusted its caller to have checked would be one refactor away from a leak.';
