-- Audit 0729c. Two HIGH findings, both introduced by 0078c/d — the work written
-- to CLOSE a privilege boundary partly re-opened it.
--
-- ── S1 · I scoped the field I had just added, and not the three beside it ──
--
-- `0078c`'s own header says why `node_id` needed a check: *"A node handed out must
-- be one the inviter can actually reach. Without this, a regional manager for the
-- North could invite someone into the South — the invitation being the thing that
-- grants the scope."*
--
-- Every word of that applies to `property_ids`, `unit_id` and `vendor_id`, which
-- have been on `invitations` since `0020` and which `accept_invitation` applies
-- unconditionally. None of them was checked.
--
-- The consequence is not theoretical. Assigning an existing user to a property
-- requires `hierarchy.write`, which only an administrator holds. Inviting one
-- reaches the **identical row** — a `property_stakeholders` grant on any property
-- in the org — needing only `people.invite`. A regional manager for the North
-- could plant a facility manager on a Southern property without ever holding the
-- capability that governs exactly that.
--
-- ⚠️ **I reasoned about the field I was adding rather than the statement I was
-- writing.** The policy governs an INSERT, and an INSERT carries every column.
--
-- 📌 And my suite could not have caught it: `tryInvite` only ever set `node_id`.
-- **A test that exercises the field you were thinking about confirms the thought,
-- not the boundary.**
--
-- ── S2 · A definer function with no caller check, reachable by anon ───────
--
-- `apply_invitation_node` was granted to `authenticated` with no check on who was
-- calling, which invitation they meant, or whether it had been accepted. It was
-- also never called — the node-on-invite feature it exists to deliver has never
-- worked, so an invitation carrying a region silently dropped it.
--
-- Live privilege check found it reachable by **anon** as well, despite the
-- `revoke ... from public` beside its grant.
--
-- Dropped rather than gated. The work belongs inside `accept_invitation`, which
-- already applies `property_ids`, `unit_id` and `vendor_id` under a token the
-- caller had to hold. A second entry point to the same effect is a second thing
-- to get right.

-- ── One definition of "may I attach someone to this?" ─────────────────────
--
-- Used by the policy below for every scope-bearing column, so the four cannot
-- drift apart the way they just did.
create or replace function current_user_may_attach_property(p_property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_property_id is null
      or current_user_role() = 'admin'
      or p_property_id in (select current_user_property_ids());
$$;

revoke all on function current_user_may_attach_property(uuid) from public;
grant execute on function current_user_may_attach_property(uuid) to authenticated, service_role;

comment on function current_user_may_attach_property is
  'Whether the caller may place somebody on this property. An administrator may place anyone anywhere; everyone else is bounded to the properties they themselves reach — which, since 0067, expands their hierarchy node subtree.';

-- ── The policy, with every attachment scoped ──────────────────────────────
drop policy if exists invitations_insert on invitations;
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()

    and (
      current_user_role() = 'admin'
      or current_user_role() = any (fm_roles())
    )

    -- Below your own rank; an administrator may additionally appoint a peer.
    and (
      role_rank(role) < role_rank(current_user_role())
      or (current_user_role() = 'admin' and role = 'admin')
    )

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
  'Who may invite whom, and what they may attach them to. Every scope-bearing column is checked — node, properties, unit and vendor — because an invitation IS the grant, and the policy governs the whole INSERT rather than the column most recently added to it (audit 0729c-S1).';

-- ── S2: the node is applied where everything else is ──────────────────────
drop function if exists apply_invitation_node(uuid, uuid);

create or replace function accept_invitation(
  p_token_hash        text,
  p_full_name         text default null,
  p_phone             text default null,
  p_telegram_chat_id  text default null,
  p_notify_whatsapp   boolean default false,
  p_notify_sms        boolean default false,
  p_notify_telegram   boolean default false
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text := nullif(trim(p_phone), '');
  v_tg text := nullif(trim(p_telegram_chat_id), '');
  p uuid;
begin
  if v_uid is null then
    raise exception 'you must be signed in to accept an invitation';
  end if;

  select * into inv from invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now()
  for update;

  if inv.id is null then
    raise exception 'this invitation is invalid, already used, or has expired';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) is distinct from lower(inv.email) then
    raise exception 'this invitation was issued to a different email address';
  end if;

  if exists (select 1 from users where id = v_uid) then
    raise exception 'this account already belongs to an organisation';
  end if;

  insert into users (
    id, org_id, role, full_name, email, phone, telegram_chat_id,
    notify_email, notify_whatsapp, notify_sms, notify_telegram
  )
  values (
    v_uid, inv.org_id, inv.role,
    coalesce(nullif(trim(p_full_name), ''), inv.full_name), inv.email,
    coalesce(v_phone, nullif(trim(inv.invite_phone), '')), v_tg,
    true,
    coalesce(p_notify_whatsapp, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_sms, false) and coalesce(v_phone, nullif(trim(inv.invite_phone), '')) is not null,
    coalesce(p_notify_telegram, false) and v_tg is not null
  );

  foreach p in array inv.property_ids loop
    insert into property_stakeholders (org_id, property_id, user_id, relation)
    values (inv.org_id, p, v_uid, inv.property_relation)
    on conflict (property_id, user_id, relation) do nothing;
  end loop;

  -- The region, applied HERE rather than by a separate function nothing called.
  -- Same transaction, same token, same authority as the property assignment
  -- immediately above it — so a manager invited with their region actually gets
  -- it, which until now they silently did not.
  if inv.node_id is not null then
    insert into property_stakeholders (org_id, user_id, node_id, relation)
    values (inv.org_id, v_uid, inv.node_id, inv.property_relation)
    on conflict do nothing;
  end if;

  if inv.unit_id is not null then
    update units set occupant_user_id = v_uid
    where id = inv.unit_id and org_id = inv.org_id;
  end if;

  if inv.vendor_id is not null then
    update vendors set user_id = v_uid
    where id = inv.vendor_id and org_id = inv.org_id;
  end if;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = v_uid
  where id = inv.id;

  perform notify_user(
    v_uid, 'system', 'Welcome aboard',
    'Your account is ready. You can change how we reach you in Settings.',
    '/dashboard'
  );

  return inv.org_id;
end;
$$;

comment on function accept_invitation is
  'Creates the account and applies every attachment the invitation carries — properties, hierarchy node, unit, vendor — in one transaction under the token the caller had to hold. The node used to be applied by a separate definer function that nothing called and anyone could reach (audit 0729c-S2).';
