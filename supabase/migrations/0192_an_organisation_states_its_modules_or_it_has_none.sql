-- OEA — a property-management firm whose entire business is rent, leases and
-- landlord statements — was being told on its own portal:
--
--     "Lettings is not enabled here. Tenancies, rent and landlord statements
--      belong to the property side of the group. A facilities organisation has
--      no leases to administer."
--
-- Nothing was wrong with that screen, the flag it reads, or the FM/PM split
-- (0182) that ran nearest to it in time. `org_has_module()` coalesces a missing
-- row to `false`, which is the correct posture for a capability — B9 modules
-- are contracted, not assumed, and defaulting an unknown module ON would be the
-- opposite mistake. The defect is one level below: **staging's OEA org had no
-- org_modules rows at all**, not even a `false` one. Verified before writing
-- anything:
--
--     dev     · Ora Egbunike & Associates → lettings=true, ai_document_checks=true
--     staging · OEA — Ora Egbunike & Assoc → (no rows)
--
-- ── Why the rows were missing ─────────────────────────────────────────────
-- `operator_provision_org` seeds them correctly and always has (0079 → 0177).
-- But it is not the only way an org has ever come into existence — the journal
-- recorded on 19 Aug that **no application code anywhere creates an org**, and
-- staging's were consequently inserted directly, by seed and by hand, straight
-- into `orgs`. An insert that goes around the provisioning function goes around
-- everything the provisioning function does.
--
-- 📌 **A capability that is contracted must still be STATED.** This is decision
-- 8's rule about `assets.scope` arriving from the other direction: there, an
-- absent `unit_id` was being read as the meaning "shared"; here, an absent
-- org_modules row is being read as the meaning "not contracted". Both are a
-- silence standing in for a fact. The difference between "this org does not
-- have lettings" and "nobody ever said whether this org has lettings" is the
-- whole of this bug, and `coalesce(..., false)` cannot tell them apart.
--
-- ── The fix, in the order it has to hold ──────────────────────────────────
-- Backfilling the missing rows alone would fix today and nothing else: the next
-- org created outside the provisioning function lands in exactly this state.
-- So the invariant is moved to where it cannot be bypassed — a trigger on
-- `orgs` — and the backfill becomes a one-off consequence of the same rule
-- rather than a separate act of judgement.
--
-- ⚠️ Deliberately NOT changing `org_has_module()`. It is referenced by the
-- tenancy-application gate, org retirement, the document-check gate and four
-- screens; making it fall back to `delivery_brand` when a row is missing would
-- push a *guess* into the one function every module gate consults, and would
-- mean a module could never be legitimately switched off for an OEA org. The
-- resolver was right. The data was absent. Fix the data, and stop it being
-- absent again.

-- ── 1. The rule, where an insert cannot go around it ──────────────────────
-- Every organisation states every module it knows about, at the moment it
-- exists. `lettings` follows the brand exactly as operator_provision_org has
-- always set it; `ai_document_checks` is off by default per decision 10 ("a
-- per-org B9 flag, off by default"), and stays off here — an org that had it
-- on keeps it on, because `on conflict do nothing` never overwrites a stated
-- fact with a default.
create or replace function seed_org_modules(p_org_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_brand text;
begin
  select delivery_brand::text into v_brand from orgs where id = p_org_id;

  insert into org_modules (org_id, module, enabled)
  values
    (p_org_id, 'lettings', v_brand = 'OEA'),
    (p_org_id, 'ai_document_checks', false)
  on conflict do nothing;
end;
$$;

revoke all on function seed_org_modules(uuid) from public, anon, authenticated;

comment on function seed_org_modules is
  'Writes the B9 module rows an organisation is missing, defaulting lettings from its delivery brand and ai_document_checks to off (decision 10). Never overwrites a stated flag — on conflict do nothing — so it is safe to call against an org that already has some of its rows. Called by the orgs insert trigger, so an org created outside operator_provision_org still states its modules.';

create or replace function orgs_seed_modules()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform seed_org_modules(new.id);
  return new;
end;
$$;

-- AFTER insert, not BEFORE: org_modules.org_id references orgs(id), so the
-- parent row has to be visible before its children can point at it.
drop trigger if exists orgs_seed_modules_trg on orgs;
create trigger orgs_seed_modules_trg
  after insert on orgs
  for each row execute function orgs_seed_modules();

-- ── 2. The backfill, as a consequence of the rule above ───────────────────
-- Every live org, not merely the one that surfaced this. Idempotent by the
-- same `on conflict do nothing`, so re-running this migration — or running it
-- on a world that was already correct, like dev — writes nothing and changes
-- nothing.
do $$
declare
  r record;
begin
  for r in select id from orgs where deleted_at is null loop
    perform seed_org_modules(r.id);
  end loop;
end;
$$;

-- ── 3. Prove it, in the migration itself ──────────────────────────────────
-- The standing rule this build has now earned five times over: a routine that
-- reports success is not evidence of success. This one refuses to commit if
-- any live organisation is still silent about either module — including,
-- specifically, an OEA-branded org whose lettings flag did not come out true.
do $$
declare
  v_silent int;
  v_oea_off int;
begin
  select count(*) into v_silent
    from orgs o
    cross join (values ('lettings'), ('ai_document_checks')) as m(module)
   where o.deleted_at is null
     and not exists (
       select 1 from org_modules om
        where om.org_id = o.id and om.module = m.module
     );

  if v_silent > 0 then
    raise exception
      'Backfill incomplete: % org/module combinations still have no row.', v_silent;
  end if;

  -- Point-in-time, not a permanent invariant: modules are operator-governed
  -- (decision 7), so an OEA org could one day legitimately contract without
  -- lettings. Today none has, and if one appears to have, that is this exact
  -- defect rather than a decision — so stop and make a person look.
  select count(*) into v_oea_off
    from orgs o
    join org_modules om on om.org_id = o.id and om.module = 'lettings'
   where o.deleted_at is null
     and o.delivery_brand::text = 'OEA'
     and om.enabled is not true;

  if v_oea_off > 0 then
    raise exception
      'An OEA-branded organisation still has lettings disabled (% of them) — that is the defect this migration exists to close.', v_oea_off;
  end if;
end;
$$;
