-- An organisation created after 0156 has no gateway tag, so its own webhook
-- cannot find its own key.
--
-- `0156` gave every organisation six opaque characters that ride inside every
-- payment reference it mints (`OE-<TAG>-<PURPOSE>-<TIME>-<RAND>`), so an
-- incoming Paystack webhook can resolve WHICH organisation before verifying a
-- signature it cannot verify without first knowing whose key to use. It filled
-- the column with a one-off `update orgs ... where gateway_tag is null`, added
-- the shape constraint and the unique index, and stopped there. There is no
-- default and no trigger.
--
-- So an org created afterwards carries `gateway_tag = null`, and:
--
--   * `payment_reference_org_tag()` filters on `gateway_tag is not null` and
--     returns null for every reference that org will ever mint;
--   * the webhook route reads that null as "pre-0154 reference — use the
--     PLATFORM key", and verifies a client organisation's callback against
--     somebody else's secret;
--   * which fails, so the collection is not recorded, which is the safe
--     direction and still the wrong outcome: money arrives at the gateway and
--     never reaches the org's ledger.
--
-- That is `0156`'s own segregation argument -- "the segregation that stops a
-- TFML payout drawing on OEA's balance" -- silently not applying to any org
-- provisioned since. Four of the nine live organisations on staging had no tag.
--
-- 📌 Third instance of one pattern in three consecutive migrations (`0205`
-- role permissions, `0206` document requirements, this): **a property every
-- organisation must have, established by a one-off backfill against the
-- organisations that existed that day.** The backfill is not the mistake --
-- existing rows do need filling. The mistake is stopping there, and it is
-- invisible until the next org is created, which is usually much later and by
-- someone else. Where the value is derivable from the row itself, as this one
-- is, the durable home is a trigger: `operator_provision_org` is not enough,
-- because `seed.mjs` and the migrations create orgs too and would each need
-- remembering separately.

-- ---- 1. The tag is minted with the row ------------------------------------
--
-- Derivation is `0156`'s, unchanged, so every existing tag stays exactly what
-- it was. The retry is new: six hex characters collide about once in sixteen
-- million, which is rare enough to ignore right up until it refuses to create
-- an organisation, at 3am, with no obvious cause. Successive slices of the
-- uuid first, then random, so the common path stays deterministic.
create or replace function assign_org_gateway_tag()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_hex  text := upper(replace(new.id::text, '-', ''));
  v_tag  text;
  v_try  integer := 0;
begin
  if new.gateway_tag is not null then
    return new;
  end if;

  loop
    v_tag := case
      when v_try < 27 then substr(v_hex, v_try + 1, 6)
      else upper(substr(md5(gen_random_uuid()::text), 1, 6))
    end;
    exit when not exists (select 1 from orgs where gateway_tag = v_tag);
    v_try := v_try + 1;
    if v_try > 60 then
      raise exception 'could not mint a unique gateway tag for %', new.id;
    end if;
  end loop;

  new.gateway_tag := v_tag;
  return new;
end;
$$;

comment on function assign_org_gateway_tag is
  'Mints orgs.gateway_tag from the row''s own id at insert. 0156 backfilled the column and left no default, so every org created after it had none and its payment references resolved to no org at all (0207).';

drop trigger if exists orgs_assign_gateway_tag on orgs;
create trigger orgs_assign_gateway_tag
  before insert on orgs
  for each row execute function assign_org_gateway_tag();

-- ---- 2. The organisations already standing without one --------------------
--
-- Row by row rather than one `update ... where gateway_tag is null`, because
-- the unique index is real and two orgs whose uuids happen to share their first
-- six hex characters would take the whole statement down with them. The trigger
-- above fires on INSERT only, so the loop mints the same way it does rather
-- than reaching for it.
do $backfill$
declare
  o     record;
  v_hex text;
  v_tag text;
  v_try integer;
  n     integer := 0;
begin
  for o in select id from orgs where gateway_tag is null loop
    v_hex := upper(replace(o.id::text, '-', ''));
    v_try := 0;
    loop
      v_tag := case
        when v_try < 27 then substr(v_hex, v_try + 1, 6)
        else upper(substr(md5(gen_random_uuid()::text), 1, 6))
      end;
      exit when not exists (select 1 from orgs where gateway_tag = v_tag);
      v_try := v_try + 1;
      if v_try > 60 then
        raise exception 'could not mint a unique gateway tag for %', o.id;
      end if;
    end loop;
    update orgs set gateway_tag = v_tag where id = o.id;
    n := n + 1;
  end loop;
  raise notice '0207: minted a gateway tag for % organisation(s)', n;
end;
$backfill$;

-- ---- 3. The guard ---------------------------------------------------------
--
-- Asserts the state this migration exists to make unreachable: no live
-- organisation without a tag, and a newly inserted one gets its own.
do $guard$
declare
  v_missing integer;
  v_org uuid;
  v_tag text;
begin
  select count(*) into v_missing from orgs where gateway_tag is null;
  if v_missing > 0 then
    raise exception '% organisation(s) still hold no gateway tag', v_missing;
  end if;

  insert into orgs (name, delivery_brand) values ('__tag_probe__', 'direct')
  returning id, gateway_tag into v_org, v_tag;

  delete from role_permissions where org_id = v_org;
  delete from application_document_requirements where org_id = v_org;
  delete from orgs where id = v_org;

  if v_tag is null or v_tag !~ '^[A-Z0-9]{6}$' then
    raise exception 'a newly created organisation was given the tag %', coalesce(v_tag, 'NULL');
  end if;
end;
$guard$;
