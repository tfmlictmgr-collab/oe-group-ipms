-- E-1 (baseline audit) — the executive dashboard aggregated whole tables in
-- JavaScript.
--
-- It selected EVERY row of tickets, service_charges, payments, sc_budgets and
-- vendors on each load and counted them in the page. Slow at scale, but the
-- reason this is a correctness finding rather than a performance one is
-- PostgREST's default 1000-row cap: once any of those tables passes it the
-- fetch silently truncates and the KPIs — collection rate, outstanding,
-- vendor liabilities — **undercount rather than error**.
--
-- An executive reading a collection rate has no way to tell a truncated figure
-- from a true one. A slow dashboard is an inconvenience; a quietly wrong one is
-- a decision made on a number that was never real.
--
-- Two grouped views (statuses and categories) plus one scalar-subquery totals
-- view. Deliberately NOT a single view joining everything: that is exactly the
-- fan-out that made `property_summary` report 30 units where there were 6.
--
-- `security_invoker` throughout, so an FM/PM still sees only their properties'
-- figures and the matrix still decides — the aggregation moves, the access
-- rules do not.

-- ── Ticket counts by status and by category ────────────────────────────────
create or replace view bi_ticket_status
with (security_invoker = on) as
  select org_id, status::text as status, count(*) as total
    from tickets
   group by org_id, status;

create or replace view bi_ticket_category
with (security_invoker = on) as
  select org_id, coalesce(category::text, 'unclassified') as category, count(*) as total
    from tickets
   group by org_id, category;

-- ── Money totals ───────────────────────────────────────────────────────────
-- Scalar subqueries, each independent, so no table can multiply another.
create or replace view bi_financials
with (security_invoker = on) as
  select
    o.id as org_id,
    (select coalesce(sum(sc.amount), 0) from service_charges sc
      where sc.org_id = o.id and sc.deleted_at is null)                    as total_invoiced,
    (select coalesce(sum(sc.amount), 0) from service_charges sc
      where sc.org_id = o.id and sc.deleted_at is null and sc.status = 'paid')
                                                                          as total_collected,
    (select coalesce(sum(p.amount), 0) from payments p
      where p.org_id = o.id and p.status not in ('remitted', 'rejected'))  as vendor_liabilities,
    (select coalesce(sum(b.total_amount), 0) from sc_budgets b
      where b.org_id = o.id)                                              as total_budgeted
  from orgs o;

-- ── Vendor scores ──────────────────────────────────────────────────────────
create or replace view bi_vendor_scores
with (security_invoker = on) as
  select
    v.org_id,
    v.id as vendor_id,
    v.name,
    round(avg(e.composite_score)::numeric, 1) as average_score,
    count(e.id) as evaluations
  from vendors v
  join vendor_evaluations e on e.vendor_id = v.id
  group by v.org_id, v.id, v.name;

comment on view bi_financials is
  'Executive money totals, aggregated in the database. Scalar subqueries rather than joins — joining these would fan out — and security_invoker so the caller''s RLS still scopes every figure.';

grant select on bi_ticket_status, bi_ticket_category, bi_financials, bi_vendor_scores
  to authenticated;
