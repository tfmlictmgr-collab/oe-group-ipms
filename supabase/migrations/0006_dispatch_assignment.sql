-- Week 3: Dispatch & assignment workflow.
-- A ticket can be dispatched to a vendor and/or an FM ops person, who then
-- acknowledges the job. Adds the ticket_status values the flow needs, the
-- assignment columns, RLS so assignees see their own jobs (closes the B7
-- "Vendor → Assigned jobs" / "FM Ops Staff → Assigned" gap), and audit.

-- New lifecycle states between open and in_progress.
alter type ticket_status add value if not exists 'assigned' before 'in_progress';
alter type ticket_status add value if not exists 'acknowledged' before 'in_progress';

alter table tickets add column assigned_vendor_id uuid references vendors(id);
alter table tickets add column assigned_to_user_id uuid references users(id);
alter table tickets add column assigned_by uuid references users(id);
alter table tickets add column assigned_at timestamptz;
alter table tickets add column acknowledged_at timestamptz;

create index tickets_assigned_vendor_idx on tickets(assigned_vendor_id);
create index tickets_assigned_user_idx on tickets(assigned_to_user_id);

-- Extend ticket visibility: an assignee sees the jobs routed to them.
-- Vendor → tickets assigned to their vendor record; FM ops → tickets assigned
-- to them directly. (Existing policy already covers sender + admin/FM/finance.)
drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
      or current_user_role() = any (array['admin','facility_manager','finance_approver']::user_role[])
    )
  );

-- Assignees may update their own assigned ticket (to acknowledge / progress it),
-- in addition to admin/FM. Vendors/ops can only touch tickets routed to them.
drop policy if exists tickets_update on tickets;
create policy tickets_update on tickets for update
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (array['admin','facility_manager']::user_role[])
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select id from vendors where user_id = auth.uid())
    )
  );

-- Audit assignment as a distinct action (status trigger already covers the
-- open→assigned→acknowledged status transitions; this captures who/whom).
create trigger audit_ticket_assignment after update on tickets
  for each row
  when (old.assigned_vendor_id is distinct from new.assigned_vendor_id
     or old.assigned_to_user_id is distinct from new.assigned_to_user_id)
  execute function log_audit('ticket.assignment');
