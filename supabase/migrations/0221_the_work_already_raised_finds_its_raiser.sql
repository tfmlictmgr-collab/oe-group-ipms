-- 0218 gave `raise_work_order` a sender. It did not give one to the work
-- already raised. (Reported again after the 28 Aug 2026 demo.)
--
-- ⚠️ The fix landed and the screen stayed empty, which is the whole report.
-- `0218` stamps `sender_id = auth.uid()` on NEW work orders; every work order
-- raised BEFORE it still carries the explicit NULL that 0120 wrote. Measured on
-- the live database: **every facility and property manager in both brands has
-- `raised = 0`**. "Raised by me" is correct, wired to the right column, and
-- empty for all of them — including the FM who raised the generator job the
-- demo's own requisition (Job101-M) was drawn against.
--
-- 📌 A fix that only applies going forward is not a fix for the person who
-- reported it. They are looking for the thing they already did.
--
-- ── Who raised it, recoverably ────────────────────────────────────────────
--
-- `raise_work_order` has stamped `reviewed_by = auth.uid()` since `0178` — "raised
-- deliberately by someone who may dispatch: reviewed". On a row that
-- `raise_work_order` created, the reviewer IS the raiser. That is the only
-- attribution available and it is a true one, not a guess.
--
-- ── Why this predicate and no wider ───────────────────────────────────────
--
-- `channel = 'portal' AND sender_id IS NULL AND reviewed_by IS NOT NULL`
--
--   * `channel = 'portal'` — the chat paths (`whatsapp`, `telegram`) also leave
--     `sender_id` null for a reporter who has no portal account, and an FM who
--     later TRIAGES one of those is written into `reviewed_by` by the ordinary
--     dispatch flow. Backfilling those would file a tenant's WhatsApp complaint
--     as something the FM raised — and, because `0218` reads the same column to
--     decide whether the reporter is a tenant, would hand the FM the tenant's
--     satisfaction form on it. Verified before writing: there are **0** such
--     rows today, and the guard is here so that stays true rather than by luck.
--   * `sender_id IS NULL` — `app/dashboard/new/actions.ts` has always stamped
--     whoever submitted the form, so a portal request WITH a sender came from
--     New Request and is already correct.
--   * `reviewed_by IS NOT NULL` — rows older than `0178` carry no reviewer and
--     are genuinely unattributable. They are left alone rather than guessed at;
--     there were 20 of them, and a wrong name on a request is worse than none.
--
-- Every row it touches is audited, so the attribution is inspectable rather
-- than asserted.

do $mig$
declare
  v_row record;
  v_n int := 0;
begin
  for v_row in
    select t.id, t.org_id, t.reviewed_by, t.summary
      from tickets t
     where t.channel = 'portal'
       and t.sender_id is null
       and t.reviewed_by is not null
  loop
    update tickets set sender_id = v_row.reviewed_by where id = v_row.id;

    insert into audit_log (org_id, actor_id, action, entity_type, entity_id,
                           before_state, after_state)
    values (v_row.org_id, null, 'ticket.raiser_recovered', 'ticket', v_row.id,
            jsonb_build_object('sender_id', null),
            jsonb_build_object('sender_id', v_row.reviewed_by::text,
                               'summary', v_row.summary,
                               'reason',
                               'raise_work_order wrote an explicit NULL sender before 0218; the raiser is recoverable from reviewed_by, which that function has stamped with auth.uid() since 0178'));
    v_n := v_n + 1;
  end loop;

  raise notice
    '0221: % work order(s) returned to the person who raised them. Rows with no reviewer predate 0178 and are left unattributed.',
    v_n;
end $mig$;

comment on column tickets.sender_id is
  'Who reported or raised this request. Set by the portal form, by chat intake where the reporter has an account, and — since 0218 — by raise_work_order, which wrote an explicit NULL before that and left an FM unable to find their own work. 0221 recovered the recoverable ones from reviewed_by. NULL now means genuinely unattributed (a chat reporter with no portal account, or a work order predating 0178), never "raised by nobody".';
