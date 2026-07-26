-- Development scaffolding for the simulated gateway.
--
-- The webhook route posts the amount returned by a SERVER-TO-SERVER lookup,
-- never the amount in the request body. That rule is the whole point of the
-- design, so the simulated adapter must not be allowed to break it by reading
-- the payload instead. This table is the simulated gateway's own record of what
-- was "charged": the checkout page writes it, verifyTransaction reads it back.
-- Same shape as asking Paystack, so the code path under test is the real one.
--
-- It is unreachable in production: the checkout page 404s when a real gateway
-- is configured or VERCEL_ENV is production. Drop this table once simulation is
-- retired — nothing else references it.

create table if not exists simulated_charges (
  reference   text primary key,
  amount      numeric(16,2) not null check (amount > 0),
  currency    text not null default 'NGN',
  status      text not null default 'success',
  paid_at     timestamptz not null default now()
);

alter table simulated_charges enable row level security;
-- No policies: nothing but the service role can see or touch it.

revoke all on table simulated_charges from anon, authenticated;
grant all on table simulated_charges to service_role;

comment on table simulated_charges is
  'Dev-only. Stands in for the gateway''s own transaction record so the simulated adapter can be verified server-to-server rather than trusting a webhook payload.';
