-- I rebuilt the policy from the wrong copy (8 Sept 2026).
--
-- ⚠️ `0279` replaced `invitations_insert` in order to change ONE clause — the
-- rank comparison — and rebuilt the rest of the policy from **`0078d`**, which
-- was three migrations stale. `0081` had since added the clauses that scope
-- every attachment an invitation carries, and rebuilding from the older copy
-- deleted all three:
--
--   * every property in `property_ids` must be one the inviter may attach to;
--   * a tenant's `unit_id` must sit on such a property;
--   * a vendor's `vendor_id` must be within their own vendor scoping.
--
-- So between 0279 and this migration, a regional manager or an FM/PM could
-- issue an invitation planting someone on a property outside their region, or
-- enrolling a tenant into a unit they do not hold. `0081`'s own header calls
-- an invitation "the grant" — that is the whole of why those clauses exist.
--
-- 📌 **This is 0183's rule, broken by the author of `0277`, in the migration
-- written immediately after it.** `0277`'s header is four paragraphs about
-- `0271` rebuilding a function body from memory instead of from the live
-- catalogue; the very next file did the same thing to a policy, from a copy
-- three versions old. Decision 26 recorded the identical fault ("first drafted
-- against 0205's copy … and was four changes stale") and decision 39 recorded
-- it again. **Knowing the rule is not the control. Reading the live object is
-- the control, and there is no version of "I only changed one line" that makes
-- the other lines somebody else's problem.**
--
-- 📌 And it was caught by `verify-role-hierarchy`, section H — "Every
-- attachment an invitation carries is scoped (audit 0729c-S1)" — three checks
-- red within a minute of the migration landing, on a suite written for exactly
-- this and named after the audit that asked for it. The migration's own
-- assertions all passed: they tested the clause I was thinking about. `0081`'s
-- header says it in advance — *a test that exercises the field you were
-- thinking about confirms the thought, not the boundary*.
--
-- Restored from `0081`, which is the last migration that defined this policy,
-- with exactly one substitution: the rank-plus-peer pair becomes the single
-- `invitable_roles()` call `0279` exists to introduce. Nothing else is
-- retyped.

drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()

    and (
      current_user_role() = 'admin'
      or current_user_role() = any (fm_roles())
    )

    -- 0279. One question, one place: an administrator issues any role
    -- including a peer administrator, a regional manager issues the five the
    -- board stated, an FM/PM keeps 0078c's "strictly below your own rank".
    and role = any (invitable_roles(current_user_role()))

    -- A hierarchy node must be inside a subtree the inviter holds.
    and (
      node_id is null
      or current_user_role() = 'admin'
      or exists (
        select 1
          from property_stakeholders s
          join org_nodes mine on mine.id = s.node_id and mine.org_id = s.org_id
          join org_nodes target on target.id = invitations.node_id and target.org_id = s.org_id
         where s.user_id = auth.uid()
           and s.node_id is not null
           and target.path like mine.path || '%'
      )
    )

    -- EVERY property in the attaché assignment, not merely the node beside it.
    -- `NOT EXISTS a property they may not attach` rather than a containment test,
    -- so an empty array passes and one bad element fails.
    and not exists (
      select 1 from unnest(coalesce(invitations.property_ids, '{}'::uuid[])) as pid
       where not current_user_may_attach_property(pid)
    )

    -- Tenant enrolment: the unit's property has to be one they may attach to.
    and (
      unit_id is null
      or current_user_role() = 'admin'
      or exists (
        select 1 from units u
         where u.id = invitations.unit_id
           and u.org_id = invitations.org_id
           and current_user_may_attach_property(u.property_id)
      )
    )

    -- Vendor enrolment: the same, through the vendor's own property scoping.
    and (
      vendor_id is null
      or current_user_role() = 'admin'
      or vendor_id in (select current_user_scoped_vendor_ids())
    )
  );

comment on policy invitations_insert on invitations is
  'Who may invite whom, and what they may attach them to. The role comes from invitable_roles() (0279); every scope-bearing column is checked — node, properties, unit and vendor — because an invitation IS the grant, and the policy governs the whole INSERT rather than the column most recently added to it (audit 0729c-S1, restored by 0280 after 0279 rebuilt this from a stale copy).';

-- ── Assert the WHOLE policy, not the clause being changed ─────────────────
--
-- ⚠️ This is the assertion `0279` should have carried. It reads the live
-- expression and requires every scope-bearing column to appear in it, so the
-- next author who replaces this policy to change one clause fails the
-- migration rather than a suite — or, as very nearly happened here, rather
-- than nothing at all until somebody looked.
do $$
declare
  v_expr text;
  v_needed text;
begin
  select pg_get_expr(pol.polwithcheck, pol.polrelid) into v_expr
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
   where c.relname = 'invitations' and pol.polname = 'invitations_insert';

  if v_expr is null then
    raise exception 'invitations_insert has no WITH CHECK expression';
  end if;

  foreach v_needed in array array[
    'invitable_roles',                    -- 0279, the role itself
    'property_ids',                       -- 0081, the attaché assignment
    'current_user_may_attach_property',   -- 0081, properties and the tenant's unit
    'unit_id',                            -- 0081, tenant enrolment
    'current_user_scoped_vendor_ids',     -- 0081, vendor enrolment
    'org_nodes'                           -- 0078c, the region handed out
  ] loop
    if v_expr !~ v_needed then
      raise exception
        'invitations_insert no longer references % — an invitation IS the grant, and this clause scopes part of it', v_needed;
    end if;
  end loop;
end $$;
