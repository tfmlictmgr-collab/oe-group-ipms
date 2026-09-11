-- The audit stage recommends; it does not approve. (Board, 29 Aug 2026.)
--
-- A LABEL change, and only a label. Who may action the stage, what it gates and
-- every rule around it are untouched.
--
-- ⚠️ Why it is worth a migration at all. `payment_chain_stages()` is where the
-- name lives that `enforce_approval_rules()` puts into its refusal:
--
--     '% is actioned by %, and you are %'
--
-- so a person refused at this stage reads the stage's name in the message. The
-- screen now says "Audit review and recommendation" and the button says
-- "Review"; if the database kept saying "approval" the two would disagree in
-- precisely the place a confused person goes looking for an explanation.
--
-- ── The substance behind the wording ──────────────────────────────────────
--
-- The auditor checks the invoice against the job card and the evidence and says
-- whether it stands up. The money is authorised after them, by the Managing
-- Partner and then the payment approver. Calling their stage an "approval" put
-- a fourth approver into a three-approver chain — in the reader's head if
-- nowhere else — which is exactly the correction `0189` made to the FM/PM
-- sign-off for the same reason: *"calling stage 1 an approval invites the
-- reading the board corrected"*.
--
-- ⚠️ Rewritten from the LIVE definition (0211), per the 0136 lesson. One string
-- changes; the roles, the tier flags, the ordering and the standard ladder are
-- byte-identical.

create or replace function payment_chain_stages(p_org_id uuid)
returns table (stage_order smallint, required_roles user_role[], tier_resolved boolean, label text)
language sql stable set search_path = public as $$
  select v.stage_order, v.required_roles, v.tier_resolved, v.label
    from (select org_payment_chain(p_org_id) as shape) c
    cross join lateral (values
      (1::smallint,
       case c.shape when 'oea' then array['payment_audit_approver']::user_role[]
                    else fm_roles() end,
       false,
       case c.shape when 'oea' then 'Audit review and recommendation'
                    else 'Work completed and signed off' end::text),
      (2::smallint,
       case c.shape when 'oea' then array['executive']::user_role[]
                    else array['payment_audit_approver']::user_role[] end,
       false,
       case c.shape when 'oea' then 'Managing Partner approval'
                    else 'Audit verification' end::text),
      (3::smallint,
       case c.shape when 'oea' then array['payment_approver']::user_role[]
                    else array['payment_approver','executive']::user_role[] end,
       true,
       case c.shape when 'oea' then 'Payment approval'
                    else 'Final approval' end::text)
    ) as v(stage_order, required_roles, tier_resolved, label);
$$;

comment on function payment_chain_stages is
  'The three pairs of hands every payment out passes through, for one organisation. OEA (decision 23): audit review and RECOMMENDATION → Managing Partner → payment approver, with the FM/PM sign-off a PRECONDITION that commences the chain rather than a rung of it. Standard: FM/PM sign-off → audit → final approval. Hardwired in both cases and configurable by nobody — what varies is delivery_brand, set at provisioning and writable by no one. The administrator appears in neither: decision 23 removed them from money approval on both chains. Stage 1''s OEA name says "recommendation" rather than "approval" because the money is authorised after it, not by it (0223).';
