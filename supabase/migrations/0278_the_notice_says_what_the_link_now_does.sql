-- The notice says what the link now does (8 Sept 2026).
--
-- `0275` repointed the tenancy-expiry notification at its own lease, and the
-- page it now opens carries the renewal panel. Its stored BODY was left alone
-- and still read *"Speak to the letting team if you would like to renew."* —
-- true, and no longer the shortest route, since the thing it now opens is
-- exactly where they can say so.
--
-- ⚠️ I declined to do this in 0275 on the grounds that it rewrites a record.
-- Asked for explicitly afterwards, and on inspection the objection does not
-- hold for this row: `user_notifications` is the in-app bell, not the record
-- of what was sent. What was actually sent is retained elsewhere and is not
-- touched here — `lease_notices` holds the claim, the recipient, the channel
-- and the delivery outcome per (lease, threshold); `audit_log` is immutable by
-- trigger; and the EMAIL that went out sits in the tenant's own inbox, beyond
-- anything this schema can reach. What changes here is one line of live UI
-- text so that it matches where its own link now goes. A bell item whose words
-- contradict its destination is the defect, not the remedy.
--
-- Narrow by construction: the exact sentence, on lease notifications only, and
-- only the trailing clause — the "<unit> at <property>." that precedes it is
-- the fact the notice was about and is left exactly as written.

update user_notifications
   set body = replace(
         body,
         'Speak to the letting team if you would like to renew.',
         'Open it to tell us whether you would like to renew.'
       )
 where entity_type = 'lease'
   and body like '%Speak to the letting team if you would like to renew.%';

-- ── Prove it, and prove the fact in front of it survived ──────────────────
do $$
declare
  v_left int;
  v_orphaned_place int;
begin
  select count(*) into v_left from user_notifications
   where entity_type = 'lease'
     and body like '%Speak to the letting team%';
  if v_left > 0 then
    raise exception '% lease notice(s) still send the reader to a channel the link no longer needs', v_left;
  end if;

  -- The replacement must not have eaten the place. Every lease notice that
  -- carries the new sentence must still name a unit and a property before it.
  select count(*) into v_orphaned_place from user_notifications
   where entity_type = 'lease'
     and body like '%Open it to tell us whether you would like to renew.%'
     and body !~ ' at .+\. Open it to tell us';
  if v_orphaned_place > 0 then
    raise exception '% lease notice(s) lost the unit and property they name', v_orphaned_place;
  end if;
end $$;
