-- Audit 0804 — S1, S2, S3 and D2.
--
-- Four findings, one migration, because three of them are the same money path
-- and fixing one without the others leaves a race that is merely unreachable
-- rather than closed.

-- ══ S1 · `create_rent_remittance` could pay a landlord twice ═══════════════
--
-- ⚠️ The function aggregated the unremitted charges, inserted a remittance for
-- the total, then marked them remitted — with **no row lock** and an
-- unconditional closing UPDATE. Under READ COMMITTED two concurrent calls (a
-- double-click, a client retry) both run the SELECT before either commits, both
-- see the same charges as unremitted, and both insert a full-amount remittance.
-- The second UPDATE is a harmless no-op; the second `remittances` row is not —
-- put through `claim_remittance_for_sending` → `record_remittance_sent` it pays
-- the landlord twice for rent collected once.
--
-- 📌 Both adjacent functions in this same path already do it correctly, which is
-- what makes the omission a slip rather than a design choice:
--   • `record_collection` (0092c) takes `for update` on `payment_intents` and
--     `rent_charges` before posting.
--   • `claim_remittance_for_sending` (0041) takes `for update` on the
--     `remittances` row and gates the transition on `status = 'queued'` — the
--     exact claim-before-you-send discipline the aggregation step skipped.
--
-- The fix is in three parts, and all three are needed:
--   1. lock the candidate rows (`for update of rc`) before reading them, so a
--      second caller BLOCKS rather than reading a stale snapshot;
--   2. re-check `remitted_at is null` in the closing UPDATE, so even a lock that
--      is somehow not held cannot re-claim a settled charge;
--   3. verify the UPDATE actually claimed every row it aggregated, and abort if
--      not — otherwise a lost race would leave a remittance covering charges
--      already paid out under a different one.
--
-- ⚠️ `for update` cannot appear at a query level that aggregates, so the lock is
-- taken in a subquery that only collects ids, ordered by id: two callers take
-- the rows in the same sequence and therefore cannot deadlock against each
-- other.
--
-- ══ S3 · the gate it checked could never open ══════════════════════════════
--
-- ⚠️ `has_permission('remittance.execute')` denies everyone, permanently:
-- `remittance.execute` is not in `capabilities`, is never granted in
-- `role_permissions`, and is never seeded by `seed_b7_permissions`. So this
-- function has been callable by `service_role` alone — which masked S1.
--
-- ⚖️ **It is deliberately NOT being seeded as a toggle.** Locked decision 7 names
-- "remittance execution" among the controls that are hardwired and "never appear
-- as toggles", and `capabilities` already carries `payment.remit` — *"Execute a
-- transfer to a vendor or landlord"* — as **locked**, for exactly this act.
-- Adding a grantable `remittance.execute` row would make a non-delegable control
-- delegable and give the same act two names that can disagree.
--
-- So this function is brought into line with its siblings instead.
-- `create_vendor_remittance`, `create_landlord_remittance`,
-- `claim_remittance_for_sending` and `record_remittance_sent` are all
-- **`service_role` only** (0041), and `executeRemittance()` states the reason in
-- as many words: *"authorise — finance or admin, checked here because the
-- functions below run under the service role and would otherwise make the gate
-- optional."* The authorisation lives in the server action; the grant is what
-- stops a browser reaching the function at all.
--
-- The in-function role check is kept as defence in depth, now naming the roles
-- directly rather than a capability that does not exist — so if the grant is
-- ever widened by accident, the gate is still there. Executives are absent by
-- design: decision 9 says oversight authorises and finance disburses.

create or replace function create_rent_remittance(
  p_org_id uuid,
  p_landlord_user_id uuid,
  p_property_id uuid,
  p_period text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_recipient uuid;
  v_net numeric(16,2);
  v_ids uuid[];
  v_id uuid;
  v_claimed int;
begin
  -- Defence in depth. The real gate is the grant below (service_role only) plus
  -- the calling action's own check; this fires only if someone is ever handed a
  -- direct grant, and refuses everyone who is not finance or an administrator.
  if auth.uid() is not null
     and current_user_role() not in ('admin', 'finance_approver') then
    raise exception 'only finance or an administrator may remit funds';
  end if;

  select id into v_recipient from payout_recipients
   where org_id = p_org_id and party = 'landlord' and user_id = p_landlord_user_id
     and active and recipient_code is not null
   limit 1;
  if v_recipient is null then
    raise exception 'no verified bank recipient is on file for this landlord';
  end if;

  -- ── 1. Lock the candidates ───────────────────────────────────────────────
  --
  -- Only what has been COLLECTED and not yet paid out. Remitting against a
  -- demand that is merely raised would pay a landlord money no tenant has
  -- handed over.
  --
  -- `for update of rc` locks the rent_charges rows only — `leases` is joined to
  -- reach the property and has no business being locked by a payout. A second
  -- caller blocks here, and when it is released Postgres re-evaluates the WHERE
  -- against the committed row, so the charges the first caller settled are gone
  -- from its set rather than counted again.
  select array_agg(id order by id) into v_ids
    from (
      select rc.id
        from rent_charges rc
        join leases l on l.id = rc.lease_id
       where rc.org_id = p_org_id
         and l.property_id = p_property_id
         and rc.amount_paid > 0
         and rc.remitted_at is null
       order by rc.id
       for update of rc
    ) locked;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'there is no collected rent awaiting remittance for this property';
  end if;

  -- ── 2. Total what we hold, not what we saw ───────────────────────────────
  select coalesce(sum(round(rc.landlord_net_amount * (rc.amount_paid / rc.amount), 2)), 0)
    into v_net
    from rent_charges rc
   where rc.id = any (v_ids);

  if v_net is null or v_net <= 0 then
    raise exception 'there is no collected rent awaiting remittance for this property';
  end if;

  insert into remittances (
    org_id, party, recipient_id, property_id, period, reference,
    gross_amount, management_fee, admin_fee, net_amount, status, created_by
  ) values (
    p_org_id, 'landlord', v_recipient, p_property_id, p_period,
    'RENT-REM-' || to_char(now(), 'YYYYMMDDHH24MISS') || '-' || left(replace(p_property_id::text, '-', ''), 6),
    -- Gross IS net: the fee was taken at collection and already sits in
    -- fee_income. Reporting a fee here again would double-count it in every
    -- statement that sums remittance fees, and the table's own
    -- `net = gross - fees` check would then describe a deduction nobody made.
    v_net, 0, 0, v_net, 'queued', auth.uid()
  )
  returning id into v_id;

  -- ── 3. Claim them, and prove we claimed them all ─────────────────────────
  update rent_charges
     set remitted_at = now(), remittance_id = v_id
   where id = any (v_ids)
     and remitted_at is null;      -- never re-claim a settled charge
  get diagnostics v_claimed = row_count;

  -- Belt and braces on the lock. If even one charge was settled between the
  -- lock and the write, this remittance's total covers money already paid out —
  -- so the whole transaction is abandoned rather than shipped for sending.
  if v_claimed <> array_length(v_ids, 1) then
    raise exception 'these charges were remitted by another action while this one was running; nothing has been sent';
  end if;

  return v_id;
end;
$$;

-- ⚠️ `authenticated` is REVOKED. 0092b granted it, alone among the remittance
-- functions; the browser now cannot reach any of them, and the server action is
-- the only door.
revoke all on function create_rent_remittance(uuid, uuid, uuid, text) from public;
revoke all on function create_rent_remittance(uuid, uuid, uuid, text) from authenticated;
grant execute on function create_rent_remittance(uuid, uuid, uuid, text) to service_role;

comment on function create_rent_remittance is
  'Remits collected rent to a landlord. Pays out the SNAPSHOTTED net of charges already collected and deducts nothing — the fee was taken at collection (0092), and deducting again would short the landlord twice. Locks the charges it aggregates (`for update`) and aborts if any is claimed by a concurrent call, so a double-click cannot pay the same rent twice. service_role only: authorisation belongs to the calling action, exactly as for every other remittance function.';

-- ══ S2 · an index that claimed a guarantee it did not provide ══════════════
--
-- ⚠️ `rent_charges_remittance_uidx` was `unique (id) where remitted_at is not
-- null`. `id` is the primary key, so it is unique with or without the predicate:
-- the index could never reject anything a plain PK would not already forbid. It
-- was zero protection against the race above, while the column comment beside it
-- announced "Set once — the guard against paying the same month twice".
--
-- 📌 That combination is worse than no index at all. A reader auditing this later
-- reasonably concludes the double-pay is closed, and stops looking. A constraint
-- that reads as a guarantee must be one.
drop index if exists rent_charges_remittance_uidx;

-- What the lookup actually needs: find the unremitted charges for a property
-- fast. Partial, so it stays small as history accumulates.
create index if not exists rent_charges_unremitted_idx
  on rent_charges (org_id, lease_id) where remitted_at is null;

comment on column rent_charges.remitted_at is
  'When this charge was paid out to the landlord. Set once. The guard against paying the same month twice is the `for update` lock plus the `remitted_at is null` predicate inside create_rent_remittance() — NOT an index; the unique index that used to claim it here was on the primary key and enforced nothing (audit 0804 S2).';

-- ══ D2 · Settings → Lettings could not be saved by any administrator ═══════
--
-- ⚠️ 0083c replaced `orgs`'s blanket table-level UPDATE grant with an explicit
-- column allowlist. **Postgres does not extend such a grant to columns added
-- afterwards**, so the four columns Days 9 and 10 added arrived with no UPDATE
-- privilege for `authenticated` at all, and `saveLettingsSettings()` — which
-- writes all four through the caller's own session — failed for every admin with
-- "permission denied for table orgs".
--
-- Confirmed live before writing this, as a real signed-in OEA administrator:
-- `management_fee_pct` refused, `portal_name` (on the list) succeeded.
--
-- 📌 The gap is procedural, not conceptual. The journal records that every real
-- write path was traced by hand against this allowlist when 0083c landed. That
-- discipline was not repeated when later migrations added columns — and nothing
-- made it fail, because every suite touching these columns writes as
-- `service_role`, which bypasses column grants entirely. `verify-lettings-grants`
-- now checks it from an `authenticated` session instead of trusting the habit.
grant update (
  management_fee_pct,     -- 0090, decision 14
  admin_fee_flat,         -- 0090, the flat placeholder
  renewal_notice_days,    -- 0091, decision 15
  rent_demand_lead_days   -- 0093, decision 15
) on orgs to authenticated;

-- `slug` and `custom_domain` stay OFF the list deliberately: both are operator
-- controls written by `set_org_slug()`/`set_org_domain()` as the table owner
-- (0085, 0089). They are absent by intent, not by the same oversight.
