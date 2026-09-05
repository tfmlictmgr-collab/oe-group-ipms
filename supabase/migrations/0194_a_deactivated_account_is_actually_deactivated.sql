-- `deactivated_at` did not deactivate anything.
--
-- Found while restoring OEA's rehearsal logins on staging. Signed in as
-- `oea.fm@oegroup.test`, whose profile row carries
-- `deactivated_at = 2026-08-24T11:37:32Z`, and asked the database what it
-- thought:
--
--     sign-in                            ACCEPTED, JWT issued
--     current_user_role()                property_manager
--     properties readable                1
--     tickets readable                   5
--     has_permission('properties.write') true
--
-- A deactivated account had every privilege its role has ever had.
--
-- ── Why ───────────────────────────────────────────────────────────────────
-- Both root resolvers read the profile row without looking at the column:
--
--     current_user_role()    select role   from users where id = auth.uid();
--     current_user_org_id()  select org_id from users where id = auth.uid();
--
-- So `deactivated_at` was only ever consulted by application queries building
-- dropdown lists — "don't offer this person as an occupant". It filtered
-- someone out of a PICKER while leaving their session, their role and their
-- org membership entirely intact. The flag was cosmetic.
--
-- 📌 **A flag is not a control until something refuses because of it.** Every
-- read of this column in the codebase was a query saying "don't SHOW them",
-- and not one was a policy saying "don't LET them". Those look identical in a
-- diff and are opposites in an audit.
--
-- ⚠️ Worth stating what this means for what came before: `people.deactivate`
-- has existed as a capability since 0050, described as "Remove a person's
-- access", admin-only. No screen has ever implemented it, and had one been
-- built against the schema as it stood, it would have removed no access. The
-- capability was ahead of the control.
--
-- ── The fix, at the anchor ────────────────────────────────────────────────
-- Decision 8's rule, unchanged: ONE resolver, extended — never a second
-- mechanism beside it. Four functions read `auth.uid()` to decide reach, so
-- four functions learn the same clause. Nothing else in the system needs to
-- know, which is the whole point of the resolvers being where they are.
--
-- Rewritten from the LIVE catalogue (pg_get_functiondef), never retyped —
-- 0183's rule, because a clause lost to a typo in current_user_property_ids()
-- is a cross-region data leak.

-- ── Can this caller act at all? ───────────────────────────────────────────
-- Its own function so a screen can distinguish "deactivated" from "not signed
-- in" and say so. Readable ONLY about yourself: it takes no argument, so it
-- cannot be used to probe whether someone else's account is live.
create or replace function current_user_is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from users
     where id = auth.uid()
       and deactivated_at is null
  );
$$;

revoke all on function current_user_is_active() from public, anon;
grant execute on function current_user_is_active() to authenticated;

comment on function current_user_is_active is
  'Whether the signed-in account is still live. Takes no argument on purpose — it answers only about the caller, so it cannot enumerate whether other people''s accounts are active. Added by 0194, when deactivated_at was found to revoke nothing.';

-- ── The two root resolvers ────────────────────────────────────────────────
-- Almost every policy in the system reaches access through one of these. A
-- null org_id makes `org_id = current_user_org_id()` false rather than true,
-- so this fails CLOSED — a deactivated caller matches no row rather than
-- every row.
create or replace function current_user_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from users where id = auth.uid() and deactivated_at is null;
$$;

create or replace function current_user_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from users where id = auth.uid() and deactivated_at is null;
$$;

-- ── The two that read auth.uid() directly ─────────────────────────────────
-- These never passed through the resolvers above, so fixing those two alone
-- would leave a deactivated manager still resolving their properties and a
-- deactivated contractor still resolving their company. In practice the
-- policies consuming them also test org_id and would already fail closed —
-- but "already covered by the other check" is how a defence becomes a single
-- point of failure, and these are the two functions decision 8 and decision 17
-- named as THE scoping anchors.
--
-- Body preserved exactly as the live catalogue reported it; only the
-- deactivation clause is added.
create or replace function current_user_property_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  -- Directly assigned properties, exactly as before.
  select s.property_id
    from property_stakeholders s
   where s.user_id = auth.uid()
     and s.property_id is not null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null)

  union

  -- Everything beneath a node they are assigned to, at any depth.
  --
  -- The org comparison is between the node rows and is therefore redundant with
  -- the composite foreign keys above. It is kept because this is the function
  -- that decides what a regionally-assigned manager can reach, and a redundant
  -- check costs one comparison while its absence would cost a cross-brand leak.
  select p.id
    from property_stakeholders s
    join org_nodes anc on anc.id = s.node_id and anc.org_id = s.org_id
    join org_nodes n   on n.path like anc.path || '%' and n.org_id = anc.org_id
    join properties p  on p.site_node_id = n.id and p.org_id = anc.org_id
   where s.user_id = auth.uid()
     and s.node_id is not null
     and anc.deleted_at is null
     and n.deleted_at is null
     and p.deleted_at is null
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null);
$$;

create or replace function current_user_vendor_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select vu.vendor_id from vendor_users vu
   where vu.user_id = auth.uid()
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null)
  union
  select v.id from vendors v
   where v.user_id = auth.uid()
     and exists (select 1 from users u where u.id = auth.uid() and u.deactivated_at is null);
$$;

comment on function current_user_role is
  'The signed-in user''s role, or NULL if their account has been deactivated (0194). Every policy that branches on role therefore stops matching for a deactivated account, which is what deactivated_at was always supposed to mean.';

comment on function current_user_org_id is
  'The signed-in user''s organisation, or NULL if their account has been deactivated (0194). Fails closed: org_id = null matches no row.';

-- ── Prove it, before committing ───────────────────────────────────────────
-- Asserts the clause is present in the deployed body of each of the four. A
-- migration that reports success is not evidence of success, and the whole
-- reason this defect existed is that nobody checked what the resolver actually
-- said.
do $$
declare
  v_fn text;
  v_missing text[] := '{}';
begin
  foreach v_fn in array array[
    'current_user_role', 'current_user_org_id',
    'current_user_property_ids', 'current_user_vendor_ids'
  ] loop
    if (select pg_get_functiondef(p.oid)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_fn
         limit 1) not like '%deactivated_at is null%' then
      v_missing := v_missing || v_fn;
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception
      'These resolvers still ignore deactivation: %', array_to_string(v_missing, ', ');
  end if;
end;
$$;
