-- The last BI figure still counted in JavaScript (audit D7-E1).
--
-- `0061` moved ticket counts, money totals and vendor scores into the database
-- and left one panel behind. Budget utilisation still selected every
-- `service_charges` row carrying a `budget_id` and summed them in the page.
--
-- The comment beside it said it was "bounded by the number of BUDGETS (one per
-- property per period), not by invoices, so it does not carry the truncation
-- risk the totals above did." **That is wrong, and being wrong in a comment is
-- worse than being wrong in code** — the next reader checks the comment and moves
-- on. The query returns one row per INVOICE. With B5's 100+ properties billing
-- per period, an org passes PostgREST's 1000-row cap quickly, and past that point
-- budget utilisation silently under-reports with nothing on the page to say so.
-- A finance figure that is quietly too low is worse than one that fails.
--
-- Fan-out was the other half of the 0061 lesson: `property_summary` reported 30
-- units where six existed because a join multiplied rows. So the aggregate is a
-- scalar subquery per budget rather than a join — each one independent, nothing
-- able to multiply anything else.
--
-- `security_invoker` so the caller's own RLS decides which budgets they see. A
-- report must never show more than the dashboard it sits on.

create or replace view bi_budget_utilisation
with (security_invoker = on) as
  select
    b.id            as budget_id,
    b.org_id,
    b.property_id,
    p.name          as property_name,
    b.total_amount  as budgeted,
    (select coalesce(sum(sc.amount), 0)
       from service_charges sc
      where sc.budget_id = b.id
        and sc.deleted_at is null)                       as invoiced,
    (select coalesce(sum(sc.amount), 0)
       from service_charges sc
      where sc.budget_id = b.id
        and sc.deleted_at is null
        and sc.status = 'paid')                          as collected
  from sc_budgets b
  left join properties p on p.id = b.property_id;

comment on view bi_budget_utilisation is
  'Budgeted / invoiced / collected per budget, aggregated in the database. Replaces a page-side sum over every invoice row, which passed PostgREST''s 1000-row cap and under-reported silently. Scalar subqueries, so no join can multiply a total.';

revoke all on bi_budget_utilisation from anon;
grant select on bi_budget_utilisation to authenticated;
