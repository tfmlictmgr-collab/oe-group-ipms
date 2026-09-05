-- `org_branding_by_host` matched the Host header byte-for-byte against
-- `orgs.custom_domain`. Both `tfmlportal.com` and `www.tfmlportal.com` are
-- registered with Vercel and answer the same deployment — but only the bare
-- form was ever bound in `custom_domain`, and a real visitor's browser was
-- arriving as `www.tfmlportal.com`. The exact match found nothing, so
-- `orgForCurrentHost()` returned null, and everything downstream that reads
-- it treated the host as genuinely unbound:
--
--   * `/login` never redirected to the org's own `/o/<slug>` door, so
--     tfmlportal.com and oeaportal.com both rendered the anonymous platform
--     operator's generic "OE Group" sign-in instead of their own branding.
--   * Because that generic door carries no `expectedOrgId`, ANY valid
--     platform account signed in successfully from it — OEA's credentials
--     on tfmlportal.com, TFML's on oeaportal.com — with nothing to refuse
--     the mismatch.
--   * `app/dashboard/layout.tsx`'s own cross-org guard
--     (`hostOrg && profile.org_id !== hostOrg.id`) is written to catch
--     exactly that and sign the session back out — but it short-circuits
--     the same way "unbound host, serve everyone" is *meant* to for a
--     genuinely unbound domain, so a signed-in OEA admin reached a live
--     dashboard on tfmlportal.com's own address, under OEA's real branding
--     and their own real data (RLS never lapsed — no wrong-org DATA was
--     ever reachable), but on the wrong brand's door entirely: precisely
--     what B1 and 0112's own guard exist to prevent.
--
-- Not a data leak — a routing and login-gate failure, on the two production
-- hostnames a client actually types. Found 2026-08-20 by testing the real
-- domains rather than the `.vercel.app` URL, the same way the alias-pinning
-- incident earlier today was.
--
-- Fix: strip a leading "www." from both sides before comparing, so either
-- spelling of a bound domain resolves to the same organisation. This is the
-- one function every host-based routing and guard decision reads through —
-- fixing it here closes the gap for every org's domain, not just these two,
-- and needs no change to what is stored in `custom_domain`.
create or replace function org_branding_by_host(p_host text)
returns table (
  id uuid,
  slug text,
  name text,
  portal_name text,
  tagline text,
  login_headline text,
  logo_url text,
  theme_primary text,
  theme_accent text,
  theme_logo_text text,
  delivery_brand delivery_brand,
  is_platform_operator boolean
)
language sql stable security definer set search_path = public as $$
  select o.id, o.slug, o.name, o.portal_name, o.tagline, o.login_headline,
         o.logo_url, o.theme_primary, o.theme_accent, o.theme_logo_text,
         o.delivery_brand, o.is_platform_operator
    from orgs o
   where regexp_replace(lower(o.custom_domain), '^www\.', '')
       = regexp_replace(lower(split_part(trim(p_host), ':', 1)), '^www\.', '')
     and o.custom_domain is not null
     and o.deleted_at is null
   limit 1;
$$;

comment on function org_branding_by_host is
  'The organisation answering on a hostname, for painting its front door. At most one row and cannot list, exactly as org_public_branding. Branding only — never used to decide what data a caller may reach. Carries is_platform_operator so root routing can send the operator''s own domain to /login instead of /o/<slug> (0112). Matches a bound domain under either the bare or "www." spelling (0179) — Vercel answers both for a custom domain, and only one was ever the one stored.';
