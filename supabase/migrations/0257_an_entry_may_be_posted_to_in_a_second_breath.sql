-- An entry may be posted to in a second breath (5 Sept 2026).
--
-- ⚠️ Withdraws `ledger_entries_have_postings`, added by `0256` an hour ago.
-- The rule it enforced is defensible and the place it enforced it was wrong,
-- and `verify-ledger` said so on the first run:
--
--     FAIL  legitimate remittance refused — ledger entry ... was created with
--           no postings.
--
-- `0256` added a deferred AFTER INSERT constraint requiring an entry to have
-- postings by COMMIT. Every one of the five DATABASE FUNCTIONS that writes an
-- entry posts in the same transaction, so that check passed everywhere I
-- looked — and I looked only at functions.
--
-- The API is the case I did not look at. `ledger_entries_insert` and
-- `ledger_postings_insert` are separate RLS policies precisely so that an
-- administrator or the payment officer can write a manual journal entry through
-- PostgREST — and PostgREST gives each request its own transaction. Creating
-- the entry is therefore ALWAYS one transaction and posting to it is another,
-- and a check that demands postings by the end of the first refuses the second
-- before it can happen. It does not narrow a bad path; it removes a good one.
--
-- 📌 And it was hardening against something that never happened. The 76 rows
-- `0256` cleaned up were not entries created without postings — they were
-- entries that HAD postings, whose postings were later deleted by a
-- verification suite's cleanup while the entry itself survived. The defect was
-- entirely on the DELETE side, and `0256`'s correction to
-- `assert_entry_balanced` — the empty case is allowed only if the entry is
-- going too — closes it exactly. That half stays and is what actually holds
-- the line.
--
-- The lesson is the one this repo keeps writing down from the other direction:
-- a control added because it "seems right" rather than because something
-- reached the state it forbids will eventually refuse somebody doing their job.
-- 0161/0162's warning about controls nobody asked for, met from the inside.

drop trigger if exists ledger_entries_have_postings on ledger_entries;
drop function if exists assert_entry_has_postings();

-- What remains from 0256, restated so the two migrations read as one decision:
--   • the debris is gone (76 rows, provably postings-less and naming something
--     deleted or worth nothing);
--   • `assert_entry_balanced` still refuses to leave an entry stranded — you
--     may delete an entry and let the cascade take its postings, and you may
--     not delete the postings and walk away from the entry.
--
-- An entry created and never posted to is now possible again, as it was before
-- 0256. It is caught where it can be caught honestly — by the reconciliation
-- report, which is the screen whose job is to notice a journal that does not
-- say what the bank says.
do $$
declare v_bad int;
begin
  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'ledger_entries' and t.tgname = 'ledger_entries_have_postings'
  ) then
    raise exception 'ledger_entries_have_postings is still attached';
  end if;

  -- The half that stays, asserted rather than assumed.
  select count(*) into v_bad
    from ledger_entries le
    join orgs o on o.id = le.org_id
   where o.deleted_at is null
     and o.name not like 'PROBE%'
     and not exists (select 1 from ledger_postings lp where lp.entry_id = le.id);
  if v_bad > 0 then
    raise notice
      '% postings-less entr(ies) remain on live orgs — 0256 left anything naming something still live, deliberately.',
      v_bad;
  end if;
end $$;
