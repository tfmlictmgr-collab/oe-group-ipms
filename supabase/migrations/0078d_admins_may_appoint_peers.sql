-- "Strictly below your own rank" locked administrators out of appointing peers.
--
-- `0078c` replaced a guard that named one role with a rank comparison, which was
-- the right move — but `role_rank(role) < role_rank(current_user_role())` also
-- removed something the old rule allowed. The previous condition was
--
--     (current_user_role() = 'admin' or role <> 'admin')
--
-- which let an administrator invite ANYTHING, including another administrator.
-- The strict comparison made `admin → admin` impossible, so an organisation with
-- one administrator had no way to appoint a second.
--
-- ⚠️ That is a lockout waiting to happen, and the exact scenario that pushes
-- operators into building a standing "super admin" — the thing this system
-- deliberately does not have. An org that cannot appoint its own second
-- administrator will eventually ask someone with database access to do it, and
-- that becomes the norm.
--
-- Caught by `verify-role-hierarchy` on its first run, in the check written to
-- confirm an administrator could issue everything below them.
--
-- The rule, stated properly: **you may invite a role below your own, and an
-- administrator may also appoint a peer administrator.** The peer exception is
-- deliberately limited to `admin`:
--   • an org must be able to survive its administrator leaving
--   • `executive` stays strict — the MD / Managing Partner is an office, not a
--     pool, and an executive minting executives would let payment approval above
--     the threshold be widened from inside
--
-- The escalation property that matters is unchanged: nobody can create a role
-- ABOVE their own, and only an administrator can create an administrator.

drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()

    and (
      current_user_role() = 'admin'
      or current_user_role() = any (fm_roles())
    )

    and (
      -- Below your own rank, always.
      role_rank(role) < role_rank(current_user_role())
      -- …or an administrator appointing a peer, so an org is never one
      -- resignation away from having nobody who can add anyone.
      or (current_user_role() = 'admin' and role = 'admin')
    )

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
  );

comment on function role_rank is
  'Invitation seniority. You may invite a role below your own; an administrator may additionally appoint a peer administrator, so no organisation can be stranded with nobody able to add anyone. Nobody may create a role above their own.';
