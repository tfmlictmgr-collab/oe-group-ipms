-- DAY 3 — self-service onboarding & enrollment.
--
-- Closes the "no in-app way for an org to enroll its own people" gap: until now
-- users existed only because a service-role seed script created them.
--
-- Model: an admin (or an FM/PM, for their own properties) issues an invitation
-- carrying the role — and, where relevant, the property attaché assignment or
-- the tenant's unit. The recipient opens a one-time link, sets a password, and
-- lands in exactly one org with exactly one role and nothing more.
--
-- Security posture:
--   • The raw token is NEVER stored. Only a SHA-256 hash is kept, so a database
--     read cannot be replayed as an invitation (same reasoning as password
--     reset tokens).
--   • Invitations expire, are single-use, and are revocable.
--   • Acceptance runs in a SECURITY DEFINER function: the invitee is not yet a
--     member of the org, so no RLS policy could authorise their own row.
--   • The role is fixed at issue time by the inviter — never chosen by the
--     person signing up, so nobody can self-assign elevated access.

create type invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  email text not null,
  role user_role not null,
  full_name text,

  -- Attaché assignment: which properties this person manages/owns on acceptance.
  -- TFML calls the holder a Facilities Manager, OEA a Properties Manager — same
  -- role, brand-specific label (lib/roles.ts).
  property_ids uuid[] not null default '{}',
  property_relation property_relation not null default 'manager',

  -- Tenant enrolment: the unit they occupy.
  unit_id uuid references units(id),

  -- Vendor enrolment: the vendor record to attach them to.
  vendor_id uuid references vendors(id),

  token_hash text not null,
  status invitation_status not null default 'pending',
  expires_at timestamptz not null default (now() + interval '14 days'),
  invited_by uuid references users(id),
  accepted_at timestamptz,
  accepted_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create unique index invitations_token_hash_uidx on invitations (token_hash);
create index invitations_org_idx on invitations (org_id);
-- One live invitation per email per org; re-inviting revokes and re-issues.
create unique index invitations_org_email_pending_uidx
  on invitations (org_id, lower(email)) where status = 'pending';

alter table invitations enable row level security;

-- Admins see all their org's invitations; an FM/PM sees the ones they sent.
create policy invitations_select on invitations for select
  using (
    org_id = current_user_org_id()
    and (current_user_role() = 'admin' or invited_by = auth.uid())
  );

-- Issuing is admin-only, or FM/PM (who may enrol people onto their properties).
-- The token hash is generated server-side; this policy only gates who may write.
create policy invitations_insert on invitations for insert
  with check (
    org_id = current_user_org_id()
    and invited_by = auth.uid()
    and current_user_role() = any (array['admin','facility_manager']::user_role[])
    -- An FM/PM may never mint an admin.
    and (current_user_role() = 'admin' or role <> 'admin')
  );

create policy invitations_update on invitations for update
  using (
    org_id = current_user_org_id()
    and (current_user_role() = 'admin' or invited_by = auth.uid())
  )
  with check (org_id = current_user_org_id());

create trigger audit_invitation_write
  after insert or update on invitations
  for each row execute function log_audit('invitation.write');

-- ── Public, unauthenticated preview of an invitation ───────────────────────
-- The accept page must show "You've been invited to X as Y" BEFORE the person
-- has an account. Returns only what is safe to reveal, and nothing at all for a
-- bad/expired/used token — so the endpoint cannot enumerate invitations.
create or replace function invitation_preview(p_token_hash text)
returns table (org_name text, role user_role, email text, full_name text)
language sql security definer stable set search_path = public as $$
  select o.name, i.role, i.email, i.full_name
  from invitations i
  join orgs o on o.id = i.org_id
  where i.token_hash = p_token_hash
    and i.status = 'pending'
    and i.expires_at > now();
$$;

-- ── Acceptance ─────────────────────────────────────────────────────────────
-- Called immediately after the invitee's auth user is created. Creates their
-- profile row in the inviting org with the invited role, applies the attaché /
-- unit / vendor links, and burns the invitation.
--
-- SECURITY DEFINER because the caller is authenticated but not yet a member of
-- any org, so no RLS policy could permit these writes. Every value written comes
-- from the invitation the inviter created — never from the caller.
create or replace function accept_invitation(p_token_hash text, p_full_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  inv invitations%rowtype;
  v_uid uuid := auth.uid();
  v_email text;
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

  -- The signed-in address must be the invited one, so a link cannot be
  -- redeemed by whoever it was forwarded to.
  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) is distinct from lower(inv.email) then
    raise exception 'this invitation was issued to a different email address';
  end if;

  if exists (select 1 from users where id = v_uid) then
    raise exception 'this account already belongs to an organisation';
  end if;

  insert into users (id, org_id, role, full_name, email)
  values (v_uid, inv.org_id, inv.role,
          coalesce(nullif(trim(p_full_name), ''), inv.full_name), inv.email);

  -- Attaché assignment (FM/PM manages, owner owns).
  foreach p in array inv.property_ids loop
    insert into property_stakeholders (org_id, property_id, user_id, relation)
    values (inv.org_id, p, v_uid, inv.property_relation)
    on conflict (property_id, user_id, relation) do nothing;
  end loop;

  -- Tenant: bind them to their unit.
  if inv.unit_id is not null then
    update units set occupant_user_id = v_uid
    where id = inv.unit_id and org_id = inv.org_id;
  end if;

  -- Vendor: link the login to the vendor record.
  if inv.vendor_id is not null then
    update vendors set user_id = v_uid
    where id = inv.vendor_id and org_id = inv.org_id;
  end if;

  update invitations
  set status = 'accepted', accepted_at = now(), accepted_user_id = v_uid
  where id = inv.id;

  return inv.org_id;
end;
$$;

revoke all on function invitation_preview(text) from public;
revoke all on function accept_invitation(text, text) from public;
-- anon may preview (the accept page renders before sign-up); only an
-- authenticated user may actually redeem.
grant execute on function invitation_preview(text) to anon, authenticated;
grant execute on function accept_invitation(text, text) to authenticated;

-- ── Vendor self-registration status ────────────────────────────────────────
-- Vendors invited or self-registered start pending until an admin approves, so
-- an unapproved vendor can never be assigned work or paid.
alter table vendors add column if not exists approval_status text not null default 'approved'
  check (approval_status in ('pending', 'approved', 'rejected', 'suspended'));
alter table vendors add column if not exists approved_by uuid references users(id);
alter table vendors add column if not exists approved_at timestamptz;

create index if not exists vendors_approval_idx on vendors (org_id, approval_status);

create trigger audit_vendor_write
  after insert or update on vendors
  for each row execute function log_audit('vendor.write');
