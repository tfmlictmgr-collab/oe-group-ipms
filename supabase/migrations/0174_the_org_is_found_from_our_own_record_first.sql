-- Which org's key verifies an incoming webhook — answered from OUR OWN RECORD
-- rather than from the shape of a string.
--
-- ⚠️ THE BUG THIS CLOSES. 0156 made the SEND path per-org: since then
-- `sendCreatedRemittance` draws every transfer on `getGatewayForOrg(org_id)`,
-- so Paystack signs that transfer's webhooks with THAT ORG's secret. But the
-- webhook route resolves the org by reading a six-character tag out of the
-- reference, and only ONE of the three reference minters ever writes that tag:
--
--   • collections — `newPaymentReference(purpose, orgTag)` in
--     raisePaymentRequest. Tagged. Correct.
--   • landlord payouts — `'RENT-REM-' || to_char(now(), ...)` inside
--     create_rent_remittance (0102). No `OE-` prefix at all.
--   • requisition payouts — `newPaymentReference("requisition")` with no tag,
--     yielding `OE-RE-...`, whose second segment is two characters, not six.
--
-- Both payout shapes therefore resolved to NULL, the route fell back to the
-- platform adapter, and the HMAC could not match a body signed with the org's
-- secret. Result: a 403 on every `transfer.success` for an org with its own
-- account, `handleTransferEvent` never running, and the remittance sitting in
-- `sending` for ever with no ledger posting — indistinguishable, to whoever
-- works the stuck list, from a transfer that genuinely never left.
--
-- ── Why the record and not the tag ────────────────────────────────────────
--
-- The tag was always a workaround for not being able to look the reference up,
-- and we CAN look it up: `remittances.reference` and
-- `payment_intents.gateway_reference` are the two places every reference this
-- system has ever minted already lives, both indexed. Reading the org from
-- there fixes references already in flight as well as future ones, needs no
-- change to any reference format, and cannot be defeated by a minter that
-- forgets the tag — which is precisely how this broke.
--
-- The tag is KEPT as the last resort before null, so a reference that names an
-- org we have no record of still resolves as it did before. Nothing is removed.
--
-- ── Why this is still safe on an unverified body ──────────────────────────
--
-- Unchanged from 0156's reasoning, and worth restating because the input is now
-- used as a lookup key rather than a pattern match. This function only CHOOSES
-- WHICH SECRET TO VERIFY AGAINST. A forged payload naming another org's
-- reference is then checked against that org's secret and fails; a wrong choice
-- refuses, so the choice cannot be exploited. `p_reference` is bound as a
-- parameter throughout — there is no dynamic SQL here — and the function
-- returns nothing but an org id, so it cannot be used to probe for the
-- existence of a reference either: caller and forger both get a 403.

-- ⚠️ `limit 1` would NOT have been good enough here, and the reason is worth
-- stating. Neither `remittances.reference` nor `payment_intents.gateway_reference`
-- is globally unique — both are unique per `(org_id, reference)` (0040b, 0032) —
-- so two orgs holding one reference string is representable, and UNION ALL gives
-- no guaranteed row order to take the first of. Choosing arbitrarily between two
-- orgs would verify against a coin-flip secret. So the levels are ranked
-- explicitly, and a tie AT THE STRONGEST AVAILABLE LEVEL resolves to null: the
-- platform key, which refuses. Both outcomes are a 403, but this one is
-- deterministic and does not attribute a payment to an org at random.
create or replace function payment_reference_org_tag(p_reference text)
returns uuid language sql stable security definer set search_path = public as $$
  with candidates as (
    -- 1. An outbound transfer we sent. The case 0156 missed entirely.
    select 1 as priority, r.org_id from remittances r where r.reference = p_reference
    union all
    -- 2. A collection we raised.
    select 2, i.org_id from payment_intents i where i.gateway_reference = p_reference
    union all
    -- 3. The embedded tag (0156). Last, so a real record always beats a
    --    six-character coincidence in a reference minted somewhere else.
    select 3, o.id
      from orgs o
     where o.gateway_tag is not null
       and p_reference ~ '^OE-[A-Z0-9]{6}-'
       and o.gateway_tag = split_part(p_reference, '-', 2)
  ),
  best as (
    select org_id from candidates
     where priority = (select min(priority) from candidates)
     group by org_id
  )
  select org_id from best where (select count(*) from best) = 1;
$$;

revoke all on function payment_reference_org_tag(text) from public, anon, authenticated;
grant execute on function payment_reference_org_tag(text) to service_role;

comment on function payment_reference_org_tag is
  'The org whose gateway key should verify a webhook carrying this reference: from remittances.reference, then payment_intents.gateway_reference, then the embedded tag (0156), then null for the platform key. Resolving from our own records is what makes this correct for OUTBOUND transfers, whose references carry no tag — before 0174 every transfer webhook for an org with its own merchant account failed signature verification and the remittance stuck in `sending`. It selects a key and grants nothing: a forged reference is verified against that org''s secret and refuses (0174).';

-- Both lookups are already indexed, but only one of them uniquely — and this
-- function is on the hot path of every webhook, so it is worth being explicit.
create index if not exists remittances_reference_idx on remittances (reference);
