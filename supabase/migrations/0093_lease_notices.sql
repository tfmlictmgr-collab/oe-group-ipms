-- Renewal notices, sent once each.
--
-- `leases_due_for_notice` (0091) already returns only leases whose remaining
-- days EQUAL a configured threshold, so a daily run notifies once per threshold.
-- That is correct while the job runs exactly once a day — and a scheduler that
-- retries, a manual re-run, or two deploys racing all break it. A tenant
-- receiving the same renewal notice three times reads it as chaos, not
-- diligence.
--
-- So the record of having sent is kept, and it is the record — not the
-- schedule — that decides.

create table lease_notices (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references orgs(id) on delete cascade,
  lease_id  uuid not null,

  -- Which threshold this was: 90, 60, 30. Part of the key, because a tenancy
  -- legitimately gets several notices as it runs down.
  threshold_days integer not null check (threshold_days > 0),

  sent_at    timestamptz not null default now(),
  channel    text not null default 'email',
  recipient  text,
  delivered  boolean not null default false,
  detail     text,

  constraint lease_notices_lease_same_org_fk
    foreign key (lease_id, org_id) references leases (id, org_id) on delete cascade,
  -- The idempotency key. One notice per lease per threshold, ever.
  constraint lease_notices_once unique (lease_id, threshold_days)
);

create index lease_notices_org_idx on lease_notices (org_id, sent_at desc);

alter table lease_notices enable row level security;

create policy lease_notices_select on lease_notices for select to authenticated
  using (
    org_id = current_user_org_id()
    and exists (
      select 1 from leases l
       where l.id = lease_notices.lease_id
         and (
           l.tenant_user_id = auth.uid()
           or current_user_role() = any (oversight_roles())
           or l.property_id in (select current_user_property_ids())
         )
    )
  );

-- No write policy: notices are recorded by the job through the service role.
-- A reviewer who could insert one could mark a notice sent that never was, and
-- the tenancy would run out with everyone believing they had been told.

comment on table lease_notices is
  'Renewal notices already sent. The unique (lease, threshold) is the idempotency key — a scheduler that retries must not tell a tenant three times.';

-- ── How far ahead rent is demanded ────────────────────────────────────────
alter table orgs add column if not exists rent_demand_lead_days integer not null default 30
  check (rent_demand_lead_days >= 0 and rent_demand_lead_days <= 365);

comment on column orgs.rent_demand_lead_days is
  'How many days before a period starts its rent demand is raised. Nigerian rent is paid annually in advance, so a month''s notice is the default rather than a bill arriving on the day.';

/**
 * Leases needing a notice RIGHT NOW: at a configured threshold, and not already
 * told at that threshold.
 *
 * Supersedes `leases_due_for_notice`, which knew the schedule but not the
 * history — it would return the same lease on every run of a job that fired
 * twice in a day.
 */
create or replace function leases_needing_notice(p_org_id uuid)
returns table (
  lease_id uuid,
  tenant_user_id uuid,
  tenant_name text,
  tenant_email text,
  property_name text,
  unit_label text,
  end_date date,
  days_remaining integer,
  rent_amount numeric,
  proposed_rent numeric
)
language sql stable security definer set search_path = public as $$
  select
    l.id, l.tenant_user_id, t.full_name, t.email,
    p.name, u.label, l.end_date,
    (l.end_date - current_date)::integer,
    l.rent_amount,
    round(l.rent_amount * (1 + l.escalation_pct / 100.0), 2)
  from leases l
  join properties p on p.id = l.property_id
  join units u      on u.id = l.unit_id
  left join users t on t.id = l.tenant_user_id
  join orgs o       on o.id = l.org_id
  where l.org_id = p_org_id
    and l.deleted_at is null
    and l.status = 'active'
    and (l.end_date - current_date)::integer = any (o.renewal_notice_days)
    and not exists (
      select 1 from lease_notices n
       where n.lease_id = l.id
         and n.threshold_days = (l.end_date - current_date)::integer
    );
$$;

revoke all on function leases_needing_notice(uuid) from public;
grant execute on function leases_needing_notice(uuid) to authenticated, service_role;

comment on function leases_needing_notice is
  'Leases at a notice threshold that have not already been told at that threshold. The history decides, not the schedule — a job that retries must not notify twice.';
