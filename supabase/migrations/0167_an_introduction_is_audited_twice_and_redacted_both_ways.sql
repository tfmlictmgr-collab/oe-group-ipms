-- The one row in this schema that belongs to two organisations.
--
-- `log_audit()` (0005) derives the audit entry's org from the row itself:
--
--     v_org := coalesce((j_new->>'org_id')::uuid, (j_old->>'org_id')::uuid);
--
-- `vendor_introductions` has no `org_id`. It has `source_org_id` and
-- `target_org_id`, deliberately, because an introduction is the one thing in
-- this system that is an event in two organisations at once. So the generic
-- trigger resolved null and `audit_log.org_id` — correctly NOT NULL — refused
-- the whole insert, which took the offer down with it.
--
-- Caught by verify-vendor-self-service.mjs E3. Worth stating why it was caught
-- rather than reasoned about: the trigger was attached in 0165 by copying the
-- line used on every other table in this schema, and every other table in this
-- schema has exactly one org.
--
-- ── The fix, and why it is two rows rather than one ───────────────────────
--
-- Picking one org would leave the other with no record of an event that
-- happened to them: the receiving org would have no trace of taking on a
-- contractor's registration, or the sending org no trace of their vendor
-- sharing one. Both are audit questions somebody will eventually ask.
--
-- So each organisation gets its own entry, in its own trail, **redacted of the
-- other**. This is the same B1 reasoning as pending_vendor_introductions():
-- TFML's audit trail must not become the place OEA's existence is disclosed.
-- What each side records is what happened in their own organisation — not who
-- was on the other end of it.
--
-- The unredacted link survives in the row itself, reachable by a migration or
-- the service role, which is where a genuine cross-org investigation belongs.

drop trigger if exists audit_vendor_introduction_write on vendor_introductions;

create or replace function log_vendor_introduction()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  j jsonb := to_jsonb(new);
  j_old jsonb := case when TG_OP = 'INSERT' then null else to_jsonb(old) end;
  -- Every field EXCEPT the two that name the counterparty organisation. Built
  -- by subtraction rather than by listing what to keep, so a column added later
  -- is disclosed to both sides by default and a column that must be hidden is a
  -- deliberate edit here — the safe direction for a redaction to fail in is
  -- "somebody notices", not "nobody notices".
  j_common jsonb := j - 'source_org_id' - 'target_org_id' - 'source_vendor_id' - 'target_vendor_id';
begin
  -- The sending organisation: their vendor shared a pack. Not with whom.
  insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
  values (
    new.source_org_id, auth.uid(), 'vendor_introduction.' || lower(TG_OP),
    'vendor_introductions', new.id,
    case when j_old is null then null
         else j_old - 'source_org_id' - 'target_org_id' - 'source_vendor_id' - 'target_vendor_id'
              || jsonb_build_object('vendor_id', old.source_vendor_id) end,
    j_common || jsonb_build_object('vendor_id', new.source_vendor_id)
  );

  -- The receiving organisation: only once there is something on their side to
  -- record. An offer they have not seen is not yet an event in their org, and
  -- writing one would put a pending row in their trail before they were told
  -- about it.
  if new.status <> 'offered' then
    insert into audit_log (org_id, actor_id, action, entity_type, entity_id, before_state, after_state)
    values (
      new.target_org_id, auth.uid(), 'vendor_introduction.' || new.status::text,
      'vendor_introductions', new.id,
      null,
      j_common || jsonb_build_object('vendor_id', new.target_vendor_id)
    );
  end if;

  return new;
end;
$$;

create trigger audit_vendor_introduction_write
  after insert or update on vendor_introductions
  for each row execute function log_vendor_introduction();

comment on function log_vendor_introduction is
  'Audits an introduction into BOTH organisations'' trails, each redacted of the other''s identity. The generic log_audit() cannot serve this table: it derives org from a single org_id column, and this is the one row in the schema that has two (0167).';
