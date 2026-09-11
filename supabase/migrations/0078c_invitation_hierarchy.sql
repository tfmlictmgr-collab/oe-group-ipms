-- Who may invite whom.
--
-- Three faults, all found by asking a question the code had never been asked:
-- "can a regional manager actually invite anyone?"
--
--   1. **No.** `invitations_insert` (`0020`) admits only `admin` and
--      `facility_manager`. `regional_manager` holds `people.invite` in the
--      matrix and the invitation table refuses their write — the capability was
--      decorative. CLAUDE.md decision 9 says the role exists to invite
--      operational staff.
--
--   2. **An FM could mint an executive.** The escalation guard special-cased
--      exactly one role: `and (current_user_role() = 'admin' or role <> 'admin')`.
--      Nothing stopped a facility manager issuing an invitation with role
--      `executive` — the MD/Managing Partner, who co-holds payment approval
--      above the threshold. A guard that names ONE privileged role protects
--      against the roles that existed the day it was written.
--
--   3. **An invitation cannot carry a region.** `invitations` has `property_ids`
--      but no node, so even once (1) is fixed there is no way to invite someone
--      *as* a regional manager and give them their region in the same act.
--
-- The rule that replaces the special case: **you may only invite a role strictly
-- below your own.** Expressed as a rank, so adding a role means giving it a rank
-- rather than remembering to amend a list of exceptions.

-- ── Rank ───────────────────────────────────────────────────────────────────
--
-- Higher number = more authority. Only used for the invitation escalation rule;
-- it is deliberately NOT a permission model — what a role may DO is the matrix,
-- and what it may REACH is the property scoping. This answers one question:
-- may A create B?
create or replace function role_rank(p_role user_role)
returns integer language sql immutable as $$
  select case p_role
           when 'admin'            then 100
           when 'executive'        then 90
           when 'finance_approver' then 70
           when 'regional_manager' then 60
           when 'facility_manager' then 50
           when 'fm_ops_staff'     then 30
           when 'property_owner'   then 20
           when 'viewer'           then 15
           when 'vendor'           then 10
           when 'tenant'           then 10
           else 0
         end;
$$;

comment on function role_rank is
  'Invitation seniority only. You may invite a role strictly below your own — so a new role needs a rank, rather than every escalation guard needing a new exception. An admin (100) is the only role that can issue an admin, and nobody can issue an executive except an admin.';

-- ── A region on the invitation ─────────────────────────────────────────────
alter table invitations add column if not exists node_id uuid;

alter table invitations drop constraint if exists invitations_node_same_org_fk;
alter table invitations add constraint invitations_node_same_org_fk
  foreign key (node_id, org_id) references org_nodes (id, org_id);

comment on column invitations.node_id is
  'The hierarchy node this person is being given. Lets a regional manager be invited WITH their region, instead of being invited and then separately assigned — two steps where the second gets forgotten.';

-- ── Who may issue an invitation, and for what ──────────────────────────────
drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()

    -- Administrators, and the operational managers. A regional manager is
    -- included here for the first time; `people.invite` in the matrix has been
    -- true for them since 0072b while this policy silently refused the write.
    and (
      current_user_role() = 'admin'
      or current_user_role() = any (fm_roles())
    )

    -- Strictly below your own rank. This replaces `role <> 'admin'`, which
    -- protected the one privileged role that existed when it was written and
    -- left `executive` and `regional_manager` reachable by a facility manager.
    and role_rank(role) < role_rank(current_user_role())

    -- A node handed out must be one the inviter can actually reach. Without
    -- this, a regional manager for the North could invite someone into the South
    -- — the invitation being the thing that grants the scope.
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

-- ── Accepting one ──────────────────────────────────────────────────────────
--
-- `accept_invitation` creates the user and applies `property_ids`. It has to
-- apply the node too, or the region on the invitation is decoration.
create or replace function apply_invitation_node(p_invitation_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
begin
  select * into inv from invitations where id = p_invitation_id;
  if inv.id is null or inv.node_id is null then
    return;
  end if;

  insert into property_stakeholders (org_id, user_id, node_id, relation)
  values (inv.org_id, p_user_id, inv.node_id, 'manager')
  on conflict do nothing;
end;
$$;

revoke all on function apply_invitation_node(uuid, uuid) from public;
grant execute on function apply_invitation_node(uuid, uuid) to authenticated, service_role;
