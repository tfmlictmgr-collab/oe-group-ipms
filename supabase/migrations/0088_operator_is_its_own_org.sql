-- The platform operator gets an organisation of its own, holding no client data.
--
-- Until now `is_platform_operator` sat on "OE Group — Foundation POC", which is
-- simultaneously the control plane AND a working tenant with 58 people, its own
-- properties, tickets and ledger. That conflation is why the org launcher still
-- reads as a proof-of-concept with badges bolted on rather than a platform.
--
-- It is also a weaker security story than it needs to be. `caller_is_operator_admin()`
-- grants the single deliberate crossing of org isolation (decision 7) — the right
-- to rewrite another org's permission matrix, provision organisations, and retire
-- them. Attaching that right to an org that also runs day-to-day operations means
-- every person who ever needs admin over the POC's tickets inherits authority over
-- every other organisation on the platform. **The control plane should hold no
-- business data, so that administering the business never implies governing the
-- platform.**
--
-- After this: OE Group is the operator and owns nothing operational. The POC
-- becomes an ordinary tenant sitting alongside TFML and OEA, with all of its data
-- intact and none of its authority.

-- ── The operator organisation ─────────────────────────────────────────────
--
-- `delivery_brand = 'direct'` because it delivers nothing; the field says who
-- performs the work, and the operator performs none. Named plainly: this is the
-- entity the client list belongs to.
insert into orgs (name, delivery_brand, slug, portal_name, tagline,
                  theme_primary, theme_logo_text, login_headline)
  select 'OE Group', 'direct', 'oe-group', 'OE Group Platform',
         'The organisations OE Group administers.',
         '#8b1d1d', 'OE',
         'Sign in to the OE Group platform.'
   where not exists (select 1 from orgs where lower(slug) = 'oe-group' and deleted_at is null);

-- ── Move the flag ─────────────────────────────────────────────────────────
--
-- Two statements, deliberately. `orgs_single_operator_uidx` is a unique index on
-- `((true)) where is_platform_operator` — at most one operator, ever. A single
-- UPDATE that both clears the old and sets the new would transiently hold two
-- and the index would refuse it. Clear first, then set, inside this migration's
-- transaction so no window exists where the platform has no operator.
update orgs set is_platform_operator = false where is_platform_operator;

update orgs set is_platform_operator = true
 where lower(slug) = 'oe-group' and deleted_at is null;

-- ── The operator's own baseline ───────────────────────────────────────────
--
-- A new org starts from the B7 matrix like any other (decision 7: defaults are
-- the most restrictive workable state). The operator is not exempt from its own
-- permission model — being the operator grants authority over OTHER orgs'
-- matrices, not freedom from having one.
do $$
declare
  v_op uuid;
begin
  select id into v_op from orgs where lower(slug) = 'oe-group' and deleted_at is null;
  if v_op is null then
    raise exception 'the operator organisation was not created';
  end if;

  perform seed_b7_permissions(v_op);

  -- Lettings off: the control plane has no tenancies. Document checks off, as
  -- decision 10 requires of every org.
  insert into org_modules (org_id, module, enabled)
  values (v_op, 'lettings', false), (v_op, 'ai_document_checks', false)
  on conflict (org_id, module) do nothing;
end $$;

-- ── Guard the invariant this migration establishes ────────────────────────
--
-- The operator holds no client data. Stated where it cannot be forgotten rather
-- than left as a convention someone breaks in six months by filing "just one"
-- property against the control plane — at which point the separation this
-- migration exists to create is quietly gone.
create or replace function operator_org_holds_no_client_data()
returns trigger language plpgsql set search_path = public as $$
begin
  if exists (
    select 1 from orgs o
     where o.id = new.org_id and o.is_platform_operator
  ) then
    raise exception
      'the platform operator organisation holds no client data — % belongs to a tenant organisation', TG_TABLE_NAME;
  end if;
  return new;
end;
$$;

create trigger properties_not_on_operator
  before insert on properties
  for each row execute function operator_org_holds_no_client_data();

create trigger tickets_not_on_operator
  before insert on tickets
  for each row execute function operator_org_holds_no_client_data();

create trigger tenant_applications_not_on_operator
  before insert on tenant_applications
  for each row execute function operator_org_holds_no_client_data();

comment on function operator_org_holds_no_client_data is
  'The control plane holds no business records. Enforced rather than documented: administering a tenant must never imply governing the platform, and that only stays true while the operator org stays empty of client data.';
