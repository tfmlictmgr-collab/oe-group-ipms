-- A vendor login with no vendor company is not a vendor.
--
-- Reported: a vendor onboarded under TFML never appeared in the vendor list,
-- and could not be picked when dispatching a request. Traced to a user with
-- `role = 'vendor'` and no row in `vendors` at all.
--
-- ⚠️ The invitation machinery was not the bug, and it is worth saying so
-- plainly because it looks like the obvious culprit. `invitations.vendor_id`
-- exists, `InviteDialog` renders a vendor picker for the vendor role, and
-- `accept_invitation` already links the accepted user to the chosen company:
--
--     if inv.vendor_id is not null then
--       update vendors set user_id = v_uid ...
--
-- All of that works. The failure was upstream of it: **there is no way to
-- create a vendor company anywhere in the application.** `vendors` rows only
-- ever arrive through the public self-service application flow
-- (`approve_vendor_application`, 0021) or a seed script. TFML and OEA had
-- **zero** vendors between them, so the picker in the invite dialog was empty,
-- the invitation was issued with `vendor_id = null`, and the accepted user
-- landed with a role scoped to a company that did not exist.
--
-- The consequence is threefold and all from the same missing row: the vendor
-- list reads `vendors`, the dispatch dropdown reads `vendors`, and the
-- vendor's own My Work page reads `vendors` by `user_id`. So they are
-- invisible to staff, unassignable, and see an empty screen themselves —
-- three symptoms, one absence.
--
-- The company-creation screen is the real fix and is application code. What
-- belongs here is the guard that stops the same dead end being reachable
-- silently: an invitation to the vendor role must name the company it is a
-- login for.
alter table invitations
  add constraint invitations_vendor_role_needs_company
  check (role <> 'vendor' or vendor_id is not null)
  not valid;

-- ⚠️ `not valid` deliberately. Two vendor invitations already exist with a null
-- `vendor_id` — one revoked, one accepted (the report that started this). A
-- validating constraint would refuse to be created at all while they exist,
-- and the alternative — deleting or back-filling live invitation history to
-- make a constraint apply — edits the record of what actually happened to
-- satisfy a rule written afterwards. `not valid` enforces this on every new
-- row while leaving the existing two exactly as they occurred, which is the
-- same reasoning the audit log follows everywhere else in this build.
--
-- Validate it later, once those rows are dealt with by a person:
--     alter table invitations validate constraint invitations_vendor_role_needs_company;

comment on constraint invitations_vendor_role_needs_company on invitations is
  'A vendor invitation must name the vendor company it is a login for. Without it the accepted user gets a role scoped to a company that does not exist -- invisible in the vendor list, unassignable when dispatching, and shown an empty My Work page. NOT VALID: two pre-existing rows are grandfathered rather than rewritten.';
