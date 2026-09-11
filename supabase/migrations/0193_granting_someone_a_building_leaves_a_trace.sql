-- Attaching a CONTRACTOR to a property has been audited since 0012.
-- Attaching a MANAGER, a LANDLORD or an OCCUPANT has never been audited at all.
--
-- Found by asking the live catalogue rather than the migrations, while proving
-- out post-onboarding attachment (verify-property-attachments.mjs). The answer
-- was blunt:
--
--     property_stakeholders   (no triggers)
--     units                   units_no_hard_delete  -> block_hard_delete()
--     vendor_properties       audit_vendor_property_write -> log_audit(...)
--
-- ── Why this is the wrong way round ───────────────────────────────────────
-- `property_stakeholders` is THE access-granting table on the property side.
-- `current_user_property_ids()` reads it, and decision 8 records that resolver
-- as being referenced by **42 policy clauses**. A row in this table is what
-- makes a building visible and actionable to a person. `vendor_properties`,
-- by contrast, scopes which vendors' payment and evaluation rows an FM may
-- read — narrower, and already audited.
--
-- So the single most access-relevant write in the property domain was the one
-- leaving no trace, while a narrower one beside it left a full one. Nobody
-- decided that; 0008 predates the audit triggers in 0005 by three migrations
-- and was never revisited when they arrived.
--
-- ⚠️ `units.occupant_user_id` is the same gap wearing different clothes. 0009
-- ("unit occupant visibility") makes the occupant field what lets a tenant
-- read that unit's service-charge statements and raise requests against it.
-- Naming someone the occupant of a flat is an access grant, and it was as
-- silent as the other.
--
-- 📌 **An audit trail assembled table by table is not an audit trail.** Each of
-- these was individually reasonable at the time it was written. What none of
-- them could see is the shape of the whole: an auditor asking "who gave this
-- person access to this building, and when" could be answered for contractors
-- and for nobody else.
--
-- ── What this does NOT do ─────────────────────────────────────────────────
-- No policy changes. Nobody gains or loses access here, and the attachment
-- rules of 0067/0191 (property-level writes follow properties.write; node-level
-- writes require hierarchy.write) are untouched. This migration only makes the
-- writes that were already permitted leave the record they always should have.

-- ── 1. Attaching a person to a property or a node ─────────────────────────
-- INSERT and DELETE both matter: revoking someone's access to a building is
-- exactly as auditable an act as granting it, and a DELETE is how a mistaken
-- grant disappears. UPDATE is included for completeness — the table's own
-- one_scope constraint means a row rarely changes in place, but a relation
-- flipped from 'owner' to 'manager' would be a significant, silent escalation.
--
-- log_audit() stores the whole row in before_state/after_state, so which
-- property, which person and which relation are all recorded even though this
-- table has no single `id` column for entity_id to point at.
drop trigger if exists audit_property_stakeholder_write on property_stakeholders;
create trigger audit_property_stakeholder_write
  after insert or update or delete on property_stakeholders
  for each row execute function log_audit('property_stakeholder.write');

-- ── 2. Naming the occupant of a unit ──────────────────────────────────────
-- Guarded by a WHEN clause, in the shape 0005 already uses for payments and
-- tickets: an ordinary unit edit — relabelling a flat, correcting its floor
-- area — is not an access change and should not fill the trail with noise.
-- Only the occupant moving is recorded.
--
-- The INSERT arm is separate because `old` does not exist there, and a unit
-- created with an occupant already named is a grant like any other.
drop trigger if exists audit_unit_occupant_change on units;
create trigger audit_unit_occupant_change
  after update on units
  for each row
  when (old.occupant_user_id is distinct from new.occupant_user_id)
  execute function log_audit('unit.occupant_change');

drop trigger if exists audit_unit_occupant_set on units;
create trigger audit_unit_occupant_set
  after insert on units
  for each row
  when (new.occupant_user_id is not null)
  execute function log_audit('unit.occupant_change');

-- ── 3. Prove it, before committing ────────────────────────────────────────
-- The standing rule: a migration that reports success is not evidence of it.
do $$
declare
  v_missing text[] := '{}';
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'property_stakeholders'::regclass
       and tgname = 'audit_property_stakeholder_write'
       and not tgisinternal
  ) then
    v_missing := v_missing || 'property_stakeholders';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'units'::regclass
       and tgname in ('audit_unit_occupant_change', 'audit_unit_occupant_set')
       and not tgisinternal
  ) then
    v_missing := v_missing || 'units';
  end if;

  if array_length(v_missing, 1) > 0 then
    raise exception 'Audit trigger missing after this migration on: %',
      array_to_string(v_missing, ', ');
  end if;
end;
$$;

comment on trigger audit_property_stakeholder_write on property_stakeholders is
  'Attaching or detaching a manager/landlord — on a property or on a hierarchy node — is an access grant, because current_user_property_ids() reads this table and 42 policy clauses read that resolver. Audited from 0193; unaudited from 0008 until then, while the narrower vendor_properties beside it had been audited since 0012.';
