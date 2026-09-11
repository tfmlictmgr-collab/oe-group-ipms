-- 0184 corrected the two roles it was looking at, and the rule is about all of
-- them.
--
-- Found by `verify-request-visibility.mjs` on its first run, which is the whole
-- reason it enumerates every role rather than asserting the two that changed:
--
--     FAIL property_owner: tickets.read_all granted in 1 of 5 orgs — expected none
--
-- The org is **OE Group**, the platform operator. A `property_owner` there holds
-- organisation-wide sight of the request queue — the precise thing the board
-- has just said belongs to three roles only.
--
-- ── Why this was missed, and why that matters more than the row ────────────
--
-- 0184's correction named `finance_approver` and `payment_audit_approver`
-- explicitly, because those were the two the board direction moved. That is a
-- migration written against the DIFF rather than against the RULE. The rule is
-- "org-wide sight of requests belongs to admin, executive and the payment
-- auditor" — a closed statement about thirteen roles, of which 0184 enforced
-- two. Any grant that drifted onto a third role before today survived it
-- untouched, which is exactly what happened here.
--
-- 📌 Same shape as 0053, which caught the B7 seed granting more than B7 did and
-- recorded the lesson as *"the failure mode matters more than the instance"*.
-- The instance here is one row in an org that holds no client data (0088). The
-- failure mode is a correction that trusted its own enumeration of what needed
-- correcting.
--
-- ── The blast radius, stated honestly ─────────────────────────────────────
--
-- Nil today. The operator org holds no client rows by construction, so there is
-- no tenant complaint in it for an owner to have read, and no `property_owner`
-- account exists there. This is a latent grant, not a live exposure — and it is
-- being removed because the operator org is the single place where a stray
-- capability is most dangerous if data ever does land in it, not because
-- anything leaked.

-- ── Every role, not the two that moved ────────────────────────────────────
--
-- Written as "anything not in the allowed set", so it cannot be outlived by a
-- role added later — a role introduced next month starts with no row at all and
-- is caught by the seed, and a grant that drifts onto it afterwards is caught by
-- the next run of this same predicate in verify-request-visibility.mjs.
with corrected as (
  update role_permissions rp
     set granted = false
   where rp.capability = 'tickets.read_all'
     and rp.granted
     and rp.role not in ('admin', 'executive', 'payment_audit_approver')
  returning rp.org_id, rp.role
)
insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                       before_state, after_state)
select c.org_id, null, 'permission.baseline_correction', 'role_permission', null,
       jsonb_build_object('capability', 'tickets.read_all',
                          'role', c.role::text, 'granted', true),
       jsonb_build_object('capability', 'tickets.read_all',
                          'role', c.role::text, 'granted', false,
                          'reason',
                          'Org-wide request sight is admin/executive/payment_audit_approver only — board 21 Aug 2026. Drifted grant removed; 0184 corrected only the two roles the direction moved.')
  from corrected c;

-- ── Say it once, where both the seed and the check can read it ────────────
--
-- The set now exists as a definition rather than as three string literals
-- repeated in a migration, a seed function and a verification script. Same
-- reasoning as `oversight_roles()` (decision 9): the next role that should see
-- everything is one line here, and the next audit reads one place to learn who
-- does.
create or replace function request_read_all_roles()
returns user_role[] language sql immutable set search_path = public as $$
  select array['admin', 'executive', 'payment_audit_approver']::user_role[];
$$;

comment on function request_read_all_roles is
  'Who may see every service request in the organisation (board, 21 Aug 2026). The payment auditor is here because stage 2 of the chain checks an invoice AGAINST the job card and the evidence — an auditor who sees only what was routed to them is counter-signing, not auditing. Finance is deliberately absent: they reach a request through the payment that climbed to them (current_user_payable_ticket_ids), never through the queue.';
