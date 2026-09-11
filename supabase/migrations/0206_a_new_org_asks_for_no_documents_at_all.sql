-- An organisation created after 0070 demands no documents from an applicant,
-- and the gate that enforces documents therefore passes trivially.
--
-- `0070` moved "which documents are mandatory" out of `lib/application-form.ts`
-- and into `application_document_requirements`, so that both the form and the
-- submit gate read one source. It seeded the six rows with a **one-off
-- backfill** -- `insert ... select from orgs` -- and no function. Every
-- organisation that existed on the day it ran got its rows. Nothing gives them
-- to an organisation created afterwards: `operator_provision_org` (0176/0177)
-- seeds the permission baseline, the lettings flag and the geopolitical
-- hierarchy, and has never seeded this.
--
-- The consequence is not a missing list on a screen. `submit_tenant_application`
-- computes what is still owed as
--
--     select string_agg(r.label, ...) into v_missing
--       from application_document_requirements r
--      where r.org_id = a.org_id and r.type = a.type and r.required
--        and not exists (... an attachment of that kind ...)
--
-- With no rows, `v_missing` is NULL, the `if v_missing is not null` never
-- fires, and **an application is accepted with no identity document, no
-- passport photograph and no guarantor ID at all**. `application_document_status`
-- tells the applicant they owe nothing, so nothing about the experience says
-- anything is wrong. The two-tier reviewer that decision 10 requires then has
-- an application in front of them with no evidence to review -- and decision
-- 10's whole shape (findings against the evidence they came from, a reviewer
-- stating their own reason) presumes the evidence exists.
--
-- Found on staging, whose TFML and OEA orgs were re-created by `npm run seed`
-- on 19 Aug 2026 -- after `0070` -- and hold zero requirement rows. Dev's, which
-- predate it, hold six each. `verify-application-submission` has been reporting
-- it as "found 0 requirement(s), expected 3" and "submission was NOT refused".
--
-- 📌 Same shape as `0205`, one file apart: a rule stated ONCE against the orgs
-- that happened to exist, rather than as something an org acquires when it is
-- created. `seed_b7_permissions` got that right in 0050 and had its CONTENTS
-- regress; this one never had the function at all.

-- ---- 1. The rule, as something an organisation acquires -------------------
--
-- The six rows are exactly `0070`'s, unchanged, so an org seeded today starts
-- where every pre-0070 org already is. `required` and `sort_order` stay
-- operator-configurable afterwards through the existing `adr_admin_write`
-- policy -- this sets the starting position, it does not pin it.
create or replace function seed_application_document_requirements(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into application_document_requirements
    (org_id, type, kind, label, required, sort_order)
  select p_org_id, d.type::application_type, d.kind::attachment_kind,
         d.label, true, d.ord
    from (values
      ('individual', 'national_id',   'Government-issued ID',      1),
      ('individual', 'passport_photo','Passport photograph',       2),
      ('individual', 'guarantor_id',  'Guarantor''s ID',           3),
      ('corporate',  'cac',           'CAC certificate',           1),
      ('corporate',  'tin',           'TIN or tax clearance',      2),
      ('corporate',  'national_id',   'Authorised contact''s ID',  3)
    ) as d(type, kind, label, ord)
  on conflict (org_id, type, kind) do nothing;
end;
$$;

revoke all on function seed_application_document_requirements(uuid) from public, anon;
grant execute on function seed_application_document_requirements(uuid) to service_role;

comment on function seed_application_document_requirements is
  'The documents a new organisation asks a tenancy applicant for, at creation. `on conflict do nothing`, so it never overwrites a list an operator has since edited (0206).';

-- ---- 2. Every org acquires it at creation ---------------------------------
--
-- Added to `operator_provision_org` beside the other three things a new org is
-- given. The rest of the body is `0177`'s, unchanged.
create or replace function operator_provision_org(
  p_name           text,
  p_delivery_brand text,
  p_admin_email    text,
  p_admin_name     text,
  p_reason         text,
  p_token_hash     text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_caller    uuid := auth.uid();
  v_operator  uuid := current_user_org_id();
  v_org       uuid;
  v_base_slug text;
  v_slug      text;
  v_suffix    integer := 1;
begin
  if not caller_is_operator_admin() then
    raise exception 'only an administrator of the OE Group operator organisation may provision organisations';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'an organisation needs a name';
  end if;
  if coalesce(trim(p_admin_email), '') = '' then
    raise exception 'the first administrator needs an email address';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason is required, and it has to say something';
  end if;

  v_base_slug := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if v_base_slug = '' then
    v_base_slug := 'org';
  end if;
  v_slug := v_base_slug;
  while exists (
    select 1 from orgs where lower(slug) = v_slug and deleted_at is null
  ) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  insert into orgs (name, delivery_brand, slug)
  values (trim(p_name), p_delivery_brand::delivery_brand, v_slug)
  returning id into v_org;

  perform seed_b7_permissions(v_org);

  insert into org_modules (org_id, module, enabled)
  values (v_org, 'lettings', p_delivery_brand = 'OEA')
  on conflict do nothing;

  perform seed_org_hierarchy(v_org);

  -- 0206. Seeded for EVERY org, not only OEA-branded ones: the lettings module
  -- is a per-org flag an operator can turn on later, and a list of required
  -- documents that only appears for orgs that had lettings on the day they were
  -- created is the same "stated once, against whoever existed" mistake this
  -- migration exists to correct.
  perform seed_application_document_requirements(v_org);

  insert into invitations (org_id, email, role, full_name, token_hash, invited_by, expires_at)
  values (v_org, lower(trim(p_admin_email)), 'admin', nullif(trim(p_admin_name), ''),
          p_token_hash, v_caller, now() + interval '14 days');

  insert into operator_actions (actor_id, operator_org, target_org, action, reason, metadata)
  values (v_caller, coalesce(v_operator, v_org), v_org, 'provision_org', trim(p_reason),
          jsonb_build_object('name', trim(p_name), 'brand', p_delivery_brand,
                             'first_admin', lower(trim(p_admin_email)), 'slug', v_slug));

  return v_org;
end;
$$;

comment on function operator_provision_org is
  'Provisions a new organisation: seeds the B7 permission baseline, the lettings flag from its brand, its geopolitical hierarchy, its tenancy document requirements (0206) and an admin invitation — and a unique slug derived from the org''s own name (0177). Operator-admin only; every call is audited to operator_actions.';

-- ---- 3. The organisations already standing without them -------------------
--
-- Live rows, not just fixtures: on staging this is TFML, OEA, the operator org
-- and the POC org, every one of which could until now accept a tenancy
-- application carrying no documents whatsoever.
do $backfill$
declare
  o record;
  n integer := 0;
begin
  for o in
    select id, name from orgs
     where not exists (
       select 1 from application_document_requirements r where r.org_id = orgs.id
     )
  loop
    perform seed_application_document_requirements(o.id);
    n := n + 1;
  end loop;
  raise notice '0206: seeded document requirements for % organisation(s)', n;
end;
$backfill$;

-- ---- 4. The guard --------------------------------------------------------
--
-- The state this migration corrects is "an org exists with no requirement
-- rows", and the only durable way to keep it corrected is for provisioning to
-- give them. That is section 2; this asserts it actually happened, against a
-- probe org, inside this migration's own transaction -- the same shape 0205
-- uses, for the same reason: a PL/pgSQL body is not checked until it runs.
do $guard$
declare
  v_org uuid;
  v_n   integer;
begin
  insert into orgs (name, delivery_brand) values ('__adr_probe__', 'direct')
  returning id into v_org;

  perform seed_application_document_requirements(v_org);

  select count(*) into v_n
    from application_document_requirements where org_id = v_org;

  delete from application_document_requirements where org_id = v_org;
  delete from orgs where id = v_org;

  if v_n <> 6 then
    raise exception
      'seed_application_document_requirements produced % row(s), expected 6', v_n;
  end if;
end;
$guard$;
