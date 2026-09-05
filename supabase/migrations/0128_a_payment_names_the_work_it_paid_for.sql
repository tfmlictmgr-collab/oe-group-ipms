-- "Reconcile the ledger — match payments to tickets."
--
-- `payments.ticket_id` was added in 0118 so a vendor invoicing through their own
-- portal names the job they did. It works, and the vendor path checks it
-- properly. But of 18 payments in the database, **0 carry a ticket_id**, and
-- the column is displayed on no screen at all.
--
-- The reason is that the two ways to raise an invoice do not agree:
--
--   * `submit_vendor_invoice` (0118) — the vendor's own route. Requires the job
--     to be theirs, to be finished, and to have no other live invoice against
--     it.
--   * `SubmitInvoiceForm` — finance keying in a paper invoice. A direct insert
--     into `payments` with vendor, reference and amount. No job, no rules.
--
-- Almost every real invoice comes in on paper, so almost every payment in the
-- system is untraceable to the work it paid for. That is not a display gap; it
-- is the control B4 exists for — "no vendor payment without service
-- verification" is verified against *something*, and if nothing names what,
-- the verification is a checkbox.

-- ── The rule, where both routes must pass it ──────────────────────────────
--
-- Deliberately a TRIGGER rather than a second copy of the checks inside a new
-- staff-facing function. `submit_vendor_invoice` already holds these rules;
-- adding them again to a parallel function is how two money paths drift, which
-- is exactly what this migration is repairing. Below the two routes there is
-- one table, so the rule goes there and neither route can evade it.
create or replace function payments_work_order_is_valid()
returns trigger language plpgsql set search_path = public as $$
declare
  t tickets%rowtype;
begin
  if new.ticket_id is null then
    return new;   -- an invoice need not name a job; see the exception view below
  end if;

  select * into t from tickets where id = new.ticket_id;

  if t.id is null or t.org_id is distinct from new.org_id then
    raise exception 'that work order does not exist in this organisation';
  end if;

  -- The job must be the one this vendor actually did. Without this an invoice
  -- could be attached to somebody else's completed work and inherit the
  -- appearance of verified delivery.
  if t.assigned_vendor_id is distinct from new.vendor_id then
    raise exception 'that work order was not assigned to this vendor';
  end if;

  if t.status not in ('resolved', 'closed') then
    raise exception 'that work order is not finished yet';
  end if;

  -- One live invoice per job. Same reason there is one live payment link per
  -- rent demand: two claims for one piece of work is how it gets paid twice.
  -- ⚠️ Scoped to OTHER rows, so an ordinary update to an invoice that already
  -- names its job does not trip over itself.
  if exists (
    select 1 from payments p
     where p.ticket_id = new.ticket_id
       and p.id is distinct from new.id
       and p.status <> 'rejected'
  ) then
    raise exception 'an invoice for that work order has already been submitted';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_work_order_valid on payments;
create trigger payments_work_order_valid
  before insert or update of ticket_id, vendor_id on payments
  for each row execute function payments_work_order_is_valid();

comment on function payments_work_order_is_valid is
  'Whenever a payment names a work order, that order must exist in the same org, have been assigned to the invoicing vendor, be finished, and carry no other live invoice. Enforced at the table because two routes raise invoices -- the vendor''s own submit_vendor_invoice and finance keying in a paper one -- and only the first checked any of this.';

-- ── What finance actually reconciles ──────────────────────────────────────
--
-- The question is not "list the payments" — that screen exists. It is "which
-- money left, or is about to leave, with nothing on file saying what it bought".
-- That is the reconciliation control, and it had no surface.
--
-- ⚠️ `security invoker`, so RLS decides which payments the caller may count.
-- A view over money that answers the same for everyone is a leak dressed as a
-- report.
create or replace view payment_work_order_trace
with (security_invoker = true) as
  select
    p.id                as payment_id,
    p.org_id,
    p.vendor_id,
    v.name              as vendor_name,
    p.invoice_reference,
    p.amount,
    p.status::text      as status,
    p.created_at,
    p.ticket_id,
    t.summary           as work_order_summary,
    t.status::text      as work_order_status,
    t.property_id,
    -- The distinction that matters to a reviewer. An invoice still at
    -- verification with no job attached is untidy; one that is APPROVED or
    -- REMITTED with no job attached is money gone against no record of work.
    (p.ticket_id is null and p.status in ('approved', 'remitted')) as unmatched_and_paid
  from payments p
  left join vendors v on v.id = p.vendor_id
  left join tickets t on t.id = p.ticket_id;

comment on view payment_work_order_trace is
  'Every payment beside the work order it names, if any. security_invoker so RLS still decides what the caller may see. `unmatched_and_paid` is the exception a reviewer wants: approved or remitted with no work order behind it -- money out against no record of what was bought.';
