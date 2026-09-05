-- An entry with no postings is not an entry (5 Sept 2026).
--
-- Reported from the demo as "the ledger looks wrong": measured, **62 of OEA's
-- 63 ledger entries carried no postings at all**, and 76 across the world. An
-- entry that posts nothing moves no money, so the Journal showed a page of
-- "Collection — rent" lines while Balances and Reconciliation reported nothing
-- against them. Nobody's money was affected. Everybody's confidence was.
--
-- ── What they actually are ────────────────────────────────────────────────
--
-- Verification debris, not a product defect in the money path. Two populations,
-- both provable rather than inferred:
--
--   • 62 `payment_intent` entries whose intent NO LONGER EXISTS, carrying
--     references of the exact shape `verify-tenant-rent-payment.mjs` mints
--     (`'RENT-' || to_char(period_start,'YYYYMM') || '-' || left(...,10)`).
--   • 14 `ops_requisition` entries for requisitions of ₦0.00 named
--     `REQ-xxxxx-DISBURSE` — payment-chain probe fixtures.
--
-- ── Why they survived, which is the part worth fixing ─────────────────────
--
-- Two guards, each correct alone, leaving a gap between them.
--
--   1. `block_ledger_mutation()` refuses DELETE only when `auth.uid()` is not
--      null. A suite cleaning up through the SERVICE ROLE has no `auth.uid()`,
--      so its deletes are permitted — deliberately, or no suite could ever
--      tidy up after itself.
--
--   2. `assert_entry_balanced()` requires two postings summing to zero, and
--      then exempts the empty case outright:
--
--          -- An entry deleted entirely (cascade) leaves nothing to check.
--          if v_count = 0 then return null; end if;
--
--      📌 CORRECTION, made after this migration was applied and recorded here
--      rather than quietly: an earlier draft of this header asserted "there is
--      no cascade". There is —
--      `ledger_postings_entry_id_fkey ... ON DELETE CASCADE` — so deleting an
--      entry does take its postings with it, and that comment was right about
--      the case it names. Only the prose was corrected; the migration's
--      behaviour is unchanged and is what ran on both worlds.
--
--      The gap is the case the exemption does NOT name. It cannot tell
--      "the entry went, and its postings with it" (legitimate, and the whole
--      reason for the exemption) apart from "the postings were deleted and the
--      entry was left behind" (debris). A cleanup that removes postings
--      directly — which every suite here does, in its own HTTP request and
--      therefore its own transaction — hits the second and was permitted.
--
-- ⚠️ The invariant was written about BALANCE and not about EXISTENCE. "These
-- postings sum to zero" is checked scrupulously; "this entry has any postings"
-- was never asked, and zero postings sum to zero.
--
-- 📌 The same shape as decision 23's three defects and decision 24's fourth: a
-- write that silently does nothing. `verify-tenant-rent-payment` line 345 calls
-- `.delete()` on `ledger_entries` and never reads the error, so whether that
-- delete lands has been unobservable to the suite since it was written.

-- ── 1. The debris ─────────────────────────────────────────────────────────
--
-- Deleted rather than reversed, and that is not a breach of append-only: a
-- reversing entry exists to cancel a POSTING, and these have none. There is no
-- financial history here to preserve — only rows that make the Journal lie
-- about how much has happened.
--
-- Deliberately narrow. Only entries with zero postings, and only where the
-- thing they name is gone or was never worth anything. An entry with even one
-- posting is untouched, whatever else is true of it.
-- ⚠️ Pointers first, THEN the rows. Three tables carry a foreign key to
-- `ledger_entries` (`ops_requisitions.payable_entry_id`,
-- `payments.payable_entry_id`, `payment_intents.ledger_entry_id`), and deleting
-- an entry still referenced by one of them is refused by the FK — as it should
-- be. The debris is collected once, up front, so both halves act on exactly the
-- same set rather than on two evaluations of the same predicate.
create temporary table ledger_debris on commit drop as
  select le.id
    from ledger_entries le
   where not exists (select 1 from ledger_postings lp where lp.entry_id = le.id)
     and (
       -- Its payment intent has been deleted: nothing can ever post to it.
       (le.entity_type = 'payment_intent'
        and not exists (select 1 from payment_intents pi where pi.id = le.entity_id))
       -- Or it recognised a liability of nothing.
       or (le.entity_type = 'ops_requisition'
           and exists (select 1 from ops_requisitions r
                        where r.id = le.entity_id and r.total_amount = 0))
       -- Or it names nothing at all.
       or le.entity_type is null
     );

-- A requisition pointing at an entry about to be removed would claim a
-- liability it does not have — and `recognise_requisition_payable` returns
-- early on a non-null `payable_entry_id`, so it would never post one either.
-- Clearing the pointer is what lets the liability be recognised properly the
-- next time somebody tries.
update ops_requisitions r set payable_entry_id = null
 where r.payable_entry_id in (select id from ledger_debris);

update payments p set payable_entry_id = null
 where p.payable_entry_id in (select id from ledger_debris);

update payment_intents pi set ledger_entry_id = null
 where pi.ledger_entry_id in (select id from ledger_debris);

do $$
declare v_gone int;
begin
  delete from ledger_entries le
   where le.id in (select id from ledger_debris);
  get diagnostics v_gone = row_count;
  raise notice 'removed % postings-less ledger entr(ies)', v_gone;
end $$;

-- ── 2. The gap, closed at both ends ───────────────────────────────────────
--
-- The empty case is still allowed — it has to be, or nothing could ever be
-- cleaned up — but only when the entry is going too. "Delete the postings and
-- delete the entry" passes; "delete the postings and leave the entry" does not.
-- Deferred, so the order of the two statements inside one transaction does not
-- matter.
create or replace function assert_entry_balanced()
returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_entry uuid := coalesce(new.entry_id, old.entry_id);
  v_sum numeric(16,2);
  v_count integer;
begin
  select coalesce(sum(amount), 0), count(*) into v_sum, v_count
  from ledger_postings where entry_id = v_entry;

  -- Nothing left to check ONLY if the entry is gone too. The original read
  -- "an entry deleted entirely (cascade) leaves nothing to check" and named a
  -- cascade that does not exist; what it permitted was half of a cleanup.
  if v_count = 0 then
    if exists (select 1 from ledger_entries le where le.id = v_entry) then
      raise exception
        'ledger entry % would be left with no postings. An entry that posts nothing is not a record of anything — delete the entry too, or post a reversing pair.',
        v_entry;
    end if;
    return null;
  end if;

  if v_count < 2 then
    raise exception 'ledger entry % must have at least two postings (got %)', v_entry, v_count;
  end if;
  if v_sum <> 0 then
    raise exception 'ledger entry % does not balance: postings sum to %', v_entry, v_sum;
  end if;
  return null;
end;
$fn$;

-- And the other end: an entry that is CREATED and never posted to. Every one of
-- the five functions that writes an entry posts in the same transaction, so
-- nothing legitimate is affected — but that is true today by inspection of five
-- functions, and this makes it true by construction for the sixth somebody
-- writes next. Deferred, because the entry is necessarily inserted before its
-- postings are.
create or replace function assert_entry_has_postings()
returns trigger
language plpgsql set search_path = public as $fn$
begin
  if not exists (select 1 from ledger_postings lp where lp.entry_id = new.id) then
    raise exception
      'ledger entry % was created with no postings. Every entry states a movement between two accounts; one that states none belongs nowhere in the journal.',
      new.id;
  end if;
  return null;
end;
$fn$;

drop trigger if exists ledger_entries_have_postings on ledger_entries;
create constraint trigger ledger_entries_have_postings
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function assert_entry_has_postings();

revoke all on function assert_entry_balanced() from public, anon;
revoke all on function assert_entry_has_postings() from public, anon;
grant execute on function assert_entry_balanced() to authenticated, service_role;
grant execute on function assert_entry_has_postings() to authenticated, service_role;

-- ── 3. Proof ──────────────────────────────────────────────────────────────
do $$
declare v_left int;
begin
  select count(*) into v_left
    from ledger_entries le
   where not exists (select 1 from ledger_postings lp where lp.entry_id = le.id);

  -- Not asserted to zero: an entry whose postings were removed but which names
  -- a LIVE, non-zero payable is not debris and is not this migration's to
  -- delete. Reported so it is looked at rather than silently carried.
  if v_left > 0 then
    raise notice
      '% postings-less entr(ies) remain and were deliberately not removed — they name something still live. Review them before assuming the journal is clean.',
      v_left;
  else
    raise notice 'every ledger entry now states a movement.';
  end if;
end $$;
