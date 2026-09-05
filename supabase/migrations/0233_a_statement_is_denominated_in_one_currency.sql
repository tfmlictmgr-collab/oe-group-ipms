-- A statement is denominated in one currency, and says so.
--
-- `0228` and `0230` both carry, in their own comments, the rule they then
-- broke: rent and service charge are reported side by side and never added,
-- "because a combined total is the 0103 cross-currency mistake with a friendlier
-- label". Both then did exactly that one level down.
--
--   `sum(rc.amount)` runs across EVERY rent charge in the period regardless of
--   `rent_charges.currency`, and the figure is then labelled with the modal
--   currency — `order by count(*) desc limit 1` in `property_statement`,
--   `mode() within group` in `landlord_statement`. A property let partly in
--   Naira and partly in dollars reports the two added together under whichever
--   currency has more rows. Multi-currency is locked scope decision 4
--   (Flutterwave, FX collections), so this is not hypothetical, and the fee,
--   landlord-share, remitted and held columns are all derived from the same
--   sums, so every money figure on both statements is affected together.
--
-- **The fix is to state the currency rather than to guess it.** Both functions
-- take `p_currency`; when it is null they fall back to the property's dominant
-- currency exactly as before, but the rent half is now FILTERED to that
-- currency instead of merely labelled with it. `rent_currencies` reports how
-- many the period actually holds, so a screen can say "there are also charges
-- in USD" and offer the switch rather than silently folding them in.
--
-- `service_charges` carries no currency column at all, so the service-charge
-- half is single-currency by schema and is left untouched. The registry counts
-- (units, occupancy, live tenancies) are facts about the building and are not
-- denominated in anything.
--
-- ⚠️ SIGNATURE CHANGE. The three-argument forms are dropped rather than left
-- beside the new ones: a defaulted fourth parameter makes a three-argument call
-- ambiguous ("function is not unique"), which would fail at the call site
-- rather than here. Every caller in `app/` passes the same three arguments and
-- keeps working unchanged.

drop function if exists property_statement(uuid, date, date);
drop function if exists property_statement_lines(uuid, date, date);
drop function if exists landlord_statement(uuid, date, date);

-- ---------------------------------------------------------------------------
-- One property, one currency
-- ---------------------------------------------------------------------------

create or replace function property_statement(
  p_property_id uuid,
  p_from date,
  p_to   date,
  p_currency text default null
)
returns table (
  property_id      uuid,
  property_name    text,
  currency         text,
  rent_currencies  bigint,
  rent_charges     bigint,
  rent_demanded    numeric,
  rent_collected   numeric,
  fees_taken       numeric,
  landlord_share   numeric,
  landlord_remitted numeric,
  landlord_held    numeric,
  sc_invoices      bigint,
  sc_billed        numeric,
  sc_collected     numeric,
  sc_outstanding   numeric,
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
       and (
         p.id in (select current_user_property_ids())
         or current_user_role() = any (oversight_roles())
       )
  ),
  charges as (
    select rc.id, rc.currency, rc.amount, rc.amount_paid,
           rc.management_fee_amount, rc.admin_fee_amount,
           rc.landlord_net_amount, rc.remitted_at
      from allowed a
      join leases l        on l.property_id = a.id and l.deleted_at is null
      join rent_charges rc on rc.lease_id = l.id
     where rc.period_start >= p_from and rc.period_start <= p_to
  ),
  ccy as (
    select
      coalesce(
        upper(nullif(btrim(p_currency), '')),
        (select c.currency from charges c
          group by c.currency order by count(*) desc, c.currency limit 1),
        'NGN'
      ) as code,
      (select count(distinct c.currency) from charges c) as n
  ),
  rent as (
    select
      count(c.id) n,
      coalesce(sum(c.amount), 0) demanded,
      coalesce(sum(c.amount_paid), 0) collected,
      coalesce(sum(round(
        (c.management_fee_amount + c.admin_fee_amount)
        * (c.amount_paid / nullif(c.amount, 0)), 2)), 0) fees,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2)), 0) net,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2))
        filter (where c.remitted_at is not null), 0) remitted,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2))
        filter (where c.remitted_at is null), 0) held
    from ccy
    left join charges c on c.currency = ccy.code
  ),
  sc as (
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
    a.id, a.name, ccy.code, ccy.n,
    rent.n, rent.demanded, rent.collected, rent.fees, rent.net, rent.remitted, rent.held,
    sc.n, sc.billed, sc.collected, greatest(sc.billed - sc.collected, 0),
    reg.n, reg.occupied, ten.n
  from allowed a, ccy, rent, sc, reg, ten;
$$;

revoke all on function property_statement(uuid, date, date, text) from public;
revoke execute on function property_statement(uuid, date, date, text) from anon;
grant execute on function property_statement(uuid, date, date, text) to authenticated;

comment on function property_statement is
  'Everything that happened on one property over a period: rent demanded, collected, fees taken, the landlord''s share, what has been remitted and what is still held -- and, kept deliberately separate, the service charge billed and collected. No grand total: rent is owed to a landlord and service charge to a fund, and adding them produces a figure that means nothing (the 0103 lesson). The rent half is FILTERED to one currency, not merely labelled with the commonest one, and rent_currencies says how many the period holds (0233). Scoped through current_user_property_ids() and oversight_roles() -- one resolver, extended (decision 8), never a second one.';

create or replace function property_statement_lines(
  p_property_id uuid,
  p_from date,
  p_to   date,
  p_currency text default null
)
returns table (
  kind          text,
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
  ),
  ccy as (
    select coalesce(
      upper(nullif(btrim(p_currency), '')),
      (select rc.currency
         from allowed a
         join leases l        on l.property_id = a.id and l.deleted_at is null
         join rent_charges rc on rc.lease_id = l.id
        where rc.period_start >= p_from and rc.period_start <= p_to
        group by rc.currency order by count(*) desc, rc.currency limit 1),
      'NGN'
    ) as code
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
  cross join ccy
  join leases l        on l.property_id = a.id and l.deleted_at is null
  join rent_charges rc on rc.lease_id = l.id and rc.currency = ccy.code
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

revoke all on function property_statement_lines(uuid, date, date, text) from public;
revoke execute on function property_statement_lines(uuid, date, date, text) from anon;
grant execute on function property_statement_lines(uuid, date, date, text) to authenticated;

comment on function property_statement_lines is
  'The rent demands and service-charge invoices behind property_statement(), so the summary can be drilled into rather than taken on trust. The rent lines are filtered to the same currency the summary is denominated in, so the lines add up to the total above them (0233). Same boundary as its parent, restated rather than inherited -- a definer function that trusted its caller to have checked would be one refactor away from a leak.';

-- ---------------------------------------------------------------------------
-- One landlord, one currency per property
-- ---------------------------------------------------------------------------

create or replace function landlord_statement(
  p_landlord_user_id uuid,
  p_from date,
  p_to   date,
  p_currency text default null
)
returns table (
  property_id uuid,
  property_name text,
  currency text,
  rent_currencies bigint,
  charges bigint,
  demanded numeric,
  collected numeric,
  fees numeric,
  landlord_share numeric,
  remitted numeric,
  still_held numeric,
  sc_invoices bigint,
  sc_billed numeric,
  sc_collected numeric,
  sc_outstanding numeric
)
language sql stable security definer set search_path = public as $$
  with allowed as (
    select p.id, p.name
      from properties p
     where p.org_id = current_user_org_id()
       and exists (
         select 1 from property_stakeholders s
          where s.property_id = p.id
            and s.relation = 'owner'
            and s.user_id = p_landlord_user_id
       )
       and (
         p_landlord_user_id = auth.uid()
         or current_user_role() = any (oversight_roles())
       )
  ),
  rc_rows as (
    select a.id as pid, rc.id, rc.currency, rc.amount, rc.amount_paid,
           rc.management_fee_amount, rc.admin_fee_amount,
           rc.landlord_net_amount, rc.remitted_at
      from allowed a
      join leases l        on l.property_id = a.id and l.deleted_at is null
      join rent_charges rc on rc.lease_id = l.id
                          and rc.period_start >= p_from
                          and rc.period_start <= p_to
  ),
  ccy as (
    select
      a.id as pid,
      coalesce(
        upper(nullif(btrim(p_currency), '')),
        (select c.currency from rc_rows c where c.pid = a.id
          group by c.currency order by count(*) desc, c.currency limit 1),
        'NGN'
      ) as code,
      (select count(distinct c.currency) from rc_rows c where c.pid = a.id) as n
    from allowed a
  ),
  rent as (
    select
      y.pid,
      count(c.id) as n,
      coalesce(sum(c.amount), 0) as demanded,
      coalesce(sum(c.amount_paid), 0) as collected,
      coalesce(sum(round(
        (c.management_fee_amount + c.admin_fee_amount)
        * (c.amount_paid / nullif(c.amount, 0)), 2)), 0) as fees,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2)), 0) as net,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2))
        filter (where c.remitted_at is not null), 0) as remitted,
      coalesce(sum(round(
        c.landlord_net_amount * (c.amount_paid / nullif(c.amount, 0)), 2))
        filter (where c.remitted_at is null), 0) as held
    from ccy y
    left join rc_rows c on c.pid = y.pid and c.currency = y.code
    group by y.pid
  ),
  sc as (
    select
      a.id as pid,
      count(s.id) as n,
      coalesce(sum(s.amount), 0) as billed,
      coalesce(sum(s.amount_paid), 0) as collected
    from allowed a
    left join sc_budgets b on b.property_id = a.id
    left join service_charges s on s.budget_id = b.id
                              and s.deleted_at is null
                              and s.created_at::date >= p_from
                              and s.created_at::date <= p_to
    group by a.id
  )
  select
    a.id, a.name, y.code, y.n,
    rent.n, rent.demanded, rent.collected, rent.fees, rent.net, rent.remitted, rent.held,
    sc.n, sc.billed, sc.collected, greatest(sc.billed - sc.collected, 0)
  from allowed a
  join ccy  y    on y.pid    = a.id
  join rent      on rent.pid = a.id
  join sc        on sc.pid   = a.id
  order by a.name;
$$;

revoke all on function landlord_statement(uuid, date, date, text) from public;
revoke execute on function landlord_statement(uuid, date, date, text) from anon;
grant execute on function landlord_statement(uuid, date, date, text) to authenticated;

comment on function landlord_statement is
  'What was demanded, collected, taken in fees, remitted and still held for one landlord over a period, per property -- and, kept deliberately separate and never added to it, the service charge billed and collected on the same building (0230). The rent half is denominated in ONE currency per property and filtered to it, with rent_currencies saying how many the period holds; before 0233 it summed every currency together and labelled the result with the commonest one. Fees come from the rate snapshotted on each charge (decision 14), never recomputed, so a rate change cannot rewrite a past statement. Callable by the landlord themselves or by oversight.';
