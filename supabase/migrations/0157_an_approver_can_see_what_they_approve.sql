-- The two roles created to approve payments could not read a single payment.
--
-- ⚠️ `payments_select` and `remittances_select` both gate reads on
-- `oversight_roles()` — admin, finance_approver, executive — plus the vendor's
-- own rows and the FM's scoped ones. 0151 added `payment_audit_approver` and
-- `payment_approver` and gave them authority over those tables without giving
-- them sight of them. The result: an empty Approvals queue, and
-- `approve_payments()` answering "not awaiting approval, or not yours to
-- approve" for every id — because the SECURITY INVOKER visibility check found
-- nothing, exactly as designed.
--
-- 📌 Caught by `verify-finance-journey`, not by the chain's own suite, and the
-- reason is worth recording: `verify-approval-chain` drives every insert with
-- the SERVICE ROLE, which bypasses RLS entirely. It proved the rules hold; it
-- could not prove the roles can reach the rows those rules govern. **A suite
-- that tests a control with a key that ignores permissions cannot tell you the
-- permissions are missing.**
--
-- ── Why not just widen oversight_roles() ──────────────────────────────────
-- Because that function is what decision 9 defines as "who may SEE money and
-- the audit trail", and it is referenced by 18 policies covering the ledger,
-- bank configuration and audit visibility. A payment approver needs to see the
-- payments they approve. They have no business in the ledger or the audit
-- trail. Widening the shared definition to solve a two-table problem is how a
-- role quietly acquires reach nobody decided to give it.
--
-- So: a separate, narrow definition, used in exactly the two policies that need
-- it — the same shape `fm_roles()` already uses.

create or replace function payment_chain_roles()
returns user_role[] language sql immutable set search_path = public as $$
  select array['payment_audit_approver', 'payment_approver']::user_role[];
$$;

comment on function payment_chain_roles is
  'The roles that action an approval stage but hold no other financial authority. Deliberately NOT part of oversight_roles(): they may see what they approve, never the ledger or the audit trail (0157).';

-- ── Payments ──────────────────────────────────────────────────────────────
--
-- Rewritten from the LIVE policy expression, per the 0136 lesson. The only
-- change is the added disjunct.
drop policy if exists payments_select on payments;
create policy payments_select on payments for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      -- New: the chain roles see the payments they are asked to decide on.
      -- Org-wide, because approval authority is org-wide — an approver scoped
      -- to a subset would silently stop being able to clear the rest.
      or current_user_role() = any (payment_chain_roles())
      or vendor_id in (select vendors.id from vendors where vendors.user_id = auth.uid())
      or (
        current_user_role() = any (fm_roles())
        and vendor_id in (select current_user_scoped_vendor_ids())
      )
    )
  );

-- ── Remittances ───────────────────────────────────────────────────────────
--
-- A landlord payout IS the payable for that half of the chain (0152), so the
-- approver has to be able to read the row they are approving.
drop policy if exists remittances_select on remittances;
create policy remittances_select on remittances for select
  using (
    org_id = current_user_org_id()
    and (
      current_user_role() = any (oversight_roles())
      or current_user_role() = any (payment_chain_roles())
      or recipient_id in (
        select payout_recipients.id from payout_recipients
         where payout_recipients.user_id = auth.uid()
            or payout_recipients.vendor_id in (
                 select vendors.id from vendors where vendors.user_id = auth.uid()
               )
      )
    )
  );

-- ── The property a payout belongs to ──────────────────────────────────────
--
-- The queue renders "<property> — ₦750,000". Without `properties.read_all` the
-- name resolves to null and the approver is asked to release three quarters of
-- a million naira against a row that will not say which property it is for.
-- That is not a cosmetic gap: it removes the one fact the decision turns on.
--
-- Read-only, and narrower than it sounds — they already see every payment
-- amount in the org by the policy above.
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        -- They approve money and must see what they are approving against: the
        -- vendor, the property, and the queue. Nothing operational, nothing
        -- they could use to originate the work they later sign off.
        when r in ('payment_audit_approver', 'payment_approver') then cap.key in (
          'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'regional_manager' then cap.key in (
          'tickets.assign', 'tickets.close', 'tickets.triage_unassigned',
          'assets.write', 'assets.import',
          'vendors.read', 'vendors.write', 'vendors.evaluate',
          'properties.write', 'units.assign_occupant',
          'people.invite', 'bi.read',
          'applications.review_all'
        )

        when cap.key in ('tickets.read_all', 'assets.read',
                         'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r = 'facility_manager'

        when cap.key = 'vendors.read' then r in ('facility_manager','finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read' then r in ('facility_manager','finance_approver','property_owner')
        when cap.key = 'people.deactivate' then false
        when cap.key = 'tickets.triage_unassigned' then false

        else false
      end;

      insert into role_permissions (org_id, role, capability, granted)
      values (p_org_id, r, cap.key, v_granted)
      on conflict (org_id, role, capability) do nothing;
    end loop;
  end loop;
end;
$$;

-- `on conflict do nothing` means the rows 0153 already wrote keep their old
-- value, so the new grant has to be applied explicitly rather than reseeded.
insert into role_permissions (org_id, role, capability, granted)
select o.id, r.role, 'properties.read_all', true
  from orgs o
  cross join (values ('payment_audit_approver'::user_role), ('payment_approver'::user_role)) r(role)
 where exists (select 1 from capabilities c where c.key = 'properties.read_all')
on conflict (org_id, role, capability) do update set granted = true;
