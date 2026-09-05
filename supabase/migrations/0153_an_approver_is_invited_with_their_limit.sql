-- A payment approver without a limit is not a payment approver.
--
-- ⚠️ 0151 added `users_approval_tier_check`: a `payment_approver` MUST carry a
-- tier of 1, 2 or 3. `accept_invitation` inserts the user with role and no
-- tier — so inviting a payment approver produced an invitation that could be
-- issued, emailed and clicked, and then failed with a constraint violation at
-- the moment the person tried to accept it. The role would have been
-- unreachable in practice while looking entirely present in the dropdown.
--
-- Caught by writing the seed for verify-approval-chain, not by review: the
-- constraint and the insert are in two different migrations and neither is
-- wrong on its own.
--
-- The fix carries the limit on the invitation, where the rest of a person's
-- scope already travels — properties, unit, vendor, region (0081, 0078c). The
-- alternative, inviting them and setting the tier afterwards, is the two-step
-- pattern 0078c already rejected for regions: "invited and then separately
-- assigned — two steps where the second gets forgotten." A forgotten region is
-- an inconvenience; a forgotten spending limit is either a lockout or an
-- unbounded approver.

alter table invitations add column if not exists approval_tier smallint;

alter table invitations drop constraint if exists invitations_approval_tier_check;
alter table invitations add constraint invitations_approval_tier_check check (
  (role = 'payment_approver' and approval_tier in (1, 2, 3))
  or (role <> 'payment_approver' and approval_tier is null)
);

comment on column invitations.approval_tier is
  'The amount band a payment_approver is being given, carried on the invitation so it arrives WITH the role rather than in a second step someone has to remember (0153).';

-- ⚠️ Rewritten from the LIVE definition (`pg_get_functiondef`), per the 0136
-- lesson. The only change is `approval_tier` on the insert.
create or replace function accept_invitation(
  p_token_hash text,
  p_full_name text default null::text,
  p_phone text default null::text,
  p_telegram_chat_id text default null::text,
  p_notify_whatsapp boolean default false,
  p_notify_sms boolean default false,
  p_notify_telegram boolean default false
)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
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
    id, org_id, role, approval_tier, full_name, email, phone, telegram_chat_id,
    notify_email, notify_whatsapp, notify_sms, notify_telegram
  )
  values (
    v_uid, inv.org_id, inv.role, inv.approval_tier,
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
$function$;

comment on function accept_invitation is
  'Creates the user from a pending invitation and applies every scope it carries — properties, region, unit, vendor, and since 0153 the approval tier, without which a payment_approver invitation could be issued but never accepted.';

-- ── The two new roles get their B7 baseline ───────────────────────────────
--
-- `seed_b7_permissions` enumerates roles explicitly, so a role absent from that
-- array receives NO capability rows at all — not "denied", but missing, which
-- the matrix UI renders as an empty column. Both new roles need `bi.read` to
-- see the queue they are supposed to action.
--
-- Their actual approval authority is NOT a capability and deliberately does not
-- appear here: decision 7 lists payment approval among the non-delegable
-- controls that never become toggles. The matrix decides what they can SEE.
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
        -- vendor's record and the payment queue. Nothing operational, nothing
        -- they could use to originate the work they later sign off.
        when r in ('payment_audit_approver', 'payment_approver') then cap.key in (
          'vendors.read', 'bi.read'
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

-- Backfill every live org, or the roles exist with no permission rows at all.
do $$
declare o record;
begin
  for o in select id from orgs loop
    perform seed_b7_permissions(o.id);
  end loop;
end;
$$;
