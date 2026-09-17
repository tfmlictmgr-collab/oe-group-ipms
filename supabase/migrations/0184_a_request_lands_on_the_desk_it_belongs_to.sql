-- A service request reaches the people it concerns, and stops reaching everyone
-- else. (Board direction, 21 Aug 2026 — amends the B7 "Service requests"
-- column.)
--
-- `tickets_select` had grown six OR branches, each added for a good reason and
-- never reviewed together. Read as a whole it says: everybody operational sees
-- everything on their properties, finance sees the entire organisation, and a
-- LANDLORD sees every complaint any tenant ever made about a building they own.
-- The last one is not a policy anybody wrote; it is what four correct rules add
-- up to. This migration narrows all three.
--
-- ── 1. The landlord was never meant to be in there ────────────────────────
--
-- `current_user_property_ids()` resolves stakeholder rows WITHOUT filtering on
-- `relation`, so it returns a property for its `owner` exactly as it does for
-- its `manager`. That is right — decision 8 made it the single resolver and B7
-- gives an owner "Own props summary" — and it is what makes the ticket branch
-- leak: an owner is in scope for the property, so they are in scope for every
-- ticket on it.
--
-- ⚠️ The fix is NOT to filter `relation` inside the resolver. That function is
-- referenced by 42 policy clauses, and an owner legitimately reaches their own
-- statements, units and payments through it; narrowing it there would break
-- their portfolio while fixing their inbox. The scoping is right and the
-- CONSUMER was wrong — so the ticket branch states which roles it is for.
--
-- B7 has always been explicit: the owner's Service-requests cell reads "—".
-- They may raise a request and follow it (`sender_id`), and that is all.
--
-- ── 2. Finance stops reading the operational queue ────────────────────────
--
-- `tickets.read_all` has been granted to `finance_approver` since 0053, which
-- derived it from the pre-matrix policy rather than from B7 — the same file that
-- caught and corrected four other over-grants notes it was reproducing PREVIOUS
-- effective access deliberately. B7's Service-requests cell for finance reads
-- "Read-only (RT)", and the board has now read that as: the requests their own
-- work touches, not the organisation's whole queue. A finance approver does not
-- triage plumbing.
--
-- What replaces it is narrower and more useful: a request becomes visible to a
-- payment role when the money attached to it has REACHED THEM. Below the
-- ticket there is a payment, and `payments.ticket_id` (0128) is the link that
-- already exists to say what work a payment bought.
--
-- ── 3. Who still sees everything ──────────────────────────────────────────
--
-- `admin`, `executive` and `payment_audit_approver`. The first two by B7. The
-- third because stage 2 of the chain (0151) is *"checks an invoice against the
-- job card and the evidence"* — an auditor who can only see the job cards
-- somebody already routed to them is not auditing, they are counter-signing.

-- ── The chain, read up to a point ──────────────────────────────────────────
--
-- Generalises `is_cleared_for_disbursement`, which asks "is every stage
-- approved?". The question here is "has it got as far as MY stage?", which is
-- the same question with a bound. Written as one function so the two cannot
-- disagree about what an approval counts as — and the amount test is carried
-- across verbatim, because 0175's rule that an approval only counts at the
-- amount it was given for is the whole reason a re-opened chain is visible
-- again.
create or replace function chain_cleared_before(
  p_payable_type text,
  p_payable_id   uuid,
  p_amount       numeric,
  p_stage        smallint
)
returns boolean language sql stable set search_path = public as $$
  select not exists (
    select 1 from payment_chain_stages() s
     where s.stage_order < p_stage
       and not exists (
         select 1 from payment_approvals a
          where a.payable_type  = p_payable_type
            and a.payable_id    = p_payable_id
            and a.stage_order   = s.stage_order
            and a.decision      = 'approved'
            and a.amount        = p_amount
            and a.superseded_at is null
       )
  );
$$;

comment on function chain_cleared_before is
  'Whether every approval stage BEFORE p_stage is approved at p_amount — "has this reached my desk yet". The bounded form of is_cleared_for_disbursement, which is this function with p_stage past the last stage. One definition so the two cannot disagree about what counts as an approval; in particular an approval given at a different amount counts as none (0175).';

-- ── The one resolver for payment-desk visibility ──────────────────────────
--
-- Deliberately shaped like `current_user_property_ids()` and
-- `current_user_vendor_ids()`: a set-returning resolver the policy joins
-- against, so it is evaluated once per query rather than once per row, and so
-- the next rule that needs "which tickets is this person's money attached to"
-- extends this rather than inventing a second answer (decision 8).
--
-- 📌 It stays visible AFTER they have acted. Vanishing on approval would mean a
-- payment approver could not look back at what they signed off ten minutes ago
-- — and a record you cannot re-read is not evidence. The requirement is that it
-- does not appear BEFORE the chain reaches them, which is exactly what
-- `chain_cleared_before` tests.
create or replace function current_user_payable_ticket_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct p.ticket_id
    from payments p
   where p.ticket_id is not null
     and p.org_id = current_user_org_id()
     and p.status <> 'rejected'
     and case current_user_role()
           -- Stage 3. Visible once job sign-off and the audit check are done.
           when 'payment_approver'  then chain_cleared_before('vendor_payment', p.id, p.amount, 3::smallint)
           -- Not a chain role at all: finance DISBURSES (decision 16), which is
           -- the action that reaches their desk, and it reaches it only when
           -- every stage has cleared.
           when 'finance_approver'  then chain_cleared_before('vendor_payment', p.id, p.amount, 4::smallint)
           else false
         end;
$$;

revoke all on function current_user_payable_ticket_ids() from public, anon;
grant execute on function current_user_payable_ticket_ids() to authenticated, service_role;

comment on function current_user_payable_ticket_ids is
  'The service requests this caller may see BECAUSE money attached to them has reached their desk — never the operational queue. Empty for every role that is not payment_approver or finance_approver; the roles that see requests outright (admin, executive, payment_audit_approver) hold tickets.read_all and never reach this branch.';

-- ── The policy ─────────────────────────────────────────────────────────────
--
-- Rewritten from the LIVE definition (0163), not from 0064's original — the
-- 0136 lesson. Two branches change and one is added; the other four are
-- carried across byte-identical.
drop policy if exists tickets_select on tickets;
create policy tickets_select on tickets for select
  using (
    org_id = current_user_org_id()
    and (
      -- Unchanged. What I raised, and what was dispatched to me or my company.
      sender_id = auth.uid()
      or assigned_to_user_id = auth.uid()
      or assigned_vendor_id in (select current_user_vendor_ids())

      -- Unchanged as a clause; who HOLDS it changes below. Now: admin,
      -- executive, payment_audit_approver.
      or (select has_permission('tickets.read_all'))

      -- ⚠️ CHANGED. Was unguarded, which is how a landlord read their tenants'
      -- complaints: `current_user_property_ids()` answers for an owner exactly
      -- as it does for a manager, by design. The place scoping is right; it just
      -- needed to say whose place-scoping this branch is for.
      or (
        current_user_role() = any (fm_roles())
        and property_id in (select current_user_property_ids())
      )

      -- Unchanged. Inbound chat with no property yet, for whoever triages.
      or (property_id is null and (select has_permission('tickets.triage_unassigned')))

      -- NEW. A payment role sees the job a payment bought, once that payment
      -- has climbed as far as them.
      or id in (select current_user_payable_ticket_ids())
    )
  );

comment on policy tickets_select on tickets is
  'Everyone sees the requests that are specifically theirs: what they raised, what is dispatched to them, what their company was given. FM/PM/regional managers additionally see everything on the properties they manage — the branch that used to admit landlords too, because property scoping does not distinguish an owner from a manager. Payment roles see a request only once money attached to it reaches their desk. Org-wide sight belongs to admin, executive and the payment auditor.';

-- ── The B7 baseline, corrected ─────────────────────────────────────────────
create or replace function seed_b7_permissions(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  cap record;
  r user_role;
  v_granted boolean;
begin
  for cap in select key from capabilities where not locked loop
    foreach r in array array['tenant','vendor','fm_ops_staff','facility_manager',
                             'property_manager',
                             'finance_approver','property_owner','admin','viewer',
                             'executive','regional_manager',
                             'payment_audit_approver','payment_approver']::user_role[]
    loop
      v_granted := case
        when cap.key = 'tickets.assign_without_review' then false

        when r = 'admin' then true

        when r = 'executive' then cap.key in (
          'tickets.read_all', 'assets.read', 'sc.read_all', 'properties.read_all',
          'vendors.read', 'bi.read', 'tickets.triage_unassigned'
        )

        -- ⚠️ The auditor is separated from the approver here for the first
        -- time. Stage 2 is a check of the invoice AGAINST the job card and the
        -- evidence; that is unperformable without sight of the job cards. The
        -- payment approver, whose authority is an AMOUNT rather than a place,
        -- gets no such grant and sees only what climbs to them.
        when r = 'payment_audit_approver' then cap.key in (
          'tickets.read_all', 'vendors.read', 'bi.read', 'properties.read_all'
        )

        when r = 'payment_approver' then cap.key in (
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

        -- ⚠️ `tickets.read_all` LEAVES finance here. B7's cell for them reads
        -- "Read-only (RT)", which 0053 rendered as the whole organisation's
        -- queue; the board has now read it as the requests their own work
        -- touches. They reach those through current_user_payable_ticket_ids(),
        -- which no capability governs because it is not a privilege — it is the
        -- payment they are already holding.
        when cap.key = 'tickets.read_all' then false

        when cap.key in ('assets.read', 'sc.read_all', 'properties.read_all')
          then r = 'finance_approver'

        when cap.key in ('tickets.assign', 'tickets.close',
                         'assets.write', 'assets.import',
                         'vendors.write', 'vendors.evaluate',
                         'properties.write', 'units.assign_occupant',
                         'people.invite')
          then r in ('facility_manager', 'property_manager')

        when cap.key = 'vendors.read'
          then r in ('facility_manager', 'property_manager', 'finance_approver')
        when cap.key = 'sc.manage'    then r = 'finance_approver'
        when cap.key = 'bi.read'
          then r in ('facility_manager', 'property_manager',
                     'finance_approver', 'property_owner')
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

-- ── Existing orgs move to the corrected baseline ───────────────────────────
--
-- ⚠️ An UPDATE, not the usual `on conflict do nothing` — every org already
-- holds a `tickets.read_all` row, so the seed alone would change nothing
-- anywhere and the correction would apply only to organisations onboarded
-- after today.
--
-- 📌 This deliberately OVERWRITES any per-org customisation of this one
-- capability. Decision 7 makes the matrix operator-governed so an operator may
-- open or close a capability per org, and normally a migration must not silently
-- undo that judgement — 0183 copies rather than re-seeds for exactly that
-- reason. This is the other case: the BASELINE itself moved, by board
-- direction. An org that had turned this on for finance had turned on what B7
-- then said; leaving it would leave the leak this migration exists to close.
with corrected as (
  update role_permissions rp
     set granted = (rp.role = 'payment_audit_approver')
   where rp.capability = 'tickets.read_all'
     and rp.role in ('finance_approver', 'payment_audit_approver')
     and rp.granted is distinct from (rp.role = 'payment_audit_approver')
  returning rp.org_id, rp.role, rp.granted
)
insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                       before_state, after_state)
select c.org_id, null, 'permission.baseline_correction', 'role_permission', null,
       jsonb_build_object('capability', 'tickets.read_all',
                          'role', c.role::text, 'granted', not c.granted),
       jsonb_build_object('capability', 'tickets.read_all',
                          'role', c.role::text, 'granted', c.granted,
                          'reason', 'B7 service-request visibility narrowed, board 21 Aug 2026')
  from corrected c;
