-- The invitation page must wear the brand that sent the invitation.
--
-- It was showing a hardcoded "OE" mark and "OE Group Portal" to everyone, then
-- naming the inviting org in the body — so someone invited by TFML met an OE
-- Group page telling them TFML had invited them. Two brands on one screen, and
-- the wrong one in the position of trust. It also breaks B1: OE Group is not
-- client-facing, and this is the first page a new user ever sees.
--
-- The page is unauthenticated, so it cannot read the org through RLS; the only
-- thing it holds is the token. So the preview returns the branding alongside the
-- role, scoped to that one invitation.
--
-- DROP first: this changes the return signature, and CREATE OR REPLACE would
-- leave the old definition alongside the new one as an overload. That exact
-- mistake cost a working invitation flow earlier in this build (0031).

drop function if exists invitation_preview(text);

create function invitation_preview(p_token_hash text)
returns table (
  org_name text,
  portal_name text,
  logo_url text,
  theme_primary text,
  theme_accent text,
  theme_logo_text text,
  role user_role,
  email text,
  full_name text
)
language sql security definer stable set search_path = public as $$
  select
    o.name,
    o.portal_name,
    o.logo_url,
    o.theme_primary,
    o.theme_accent,
    o.theme_logo_text,
    i.role,
    i.email,
    i.full_name
  from invitations i
  join orgs o on o.id = i.org_id
  where i.token_hash = p_token_hash
    and i.status = 'pending'
    and i.expires_at > now();
$$;

-- Unchanged from the original: anon may preview, because the page renders before
-- the invitee has any account. Only branding and the invitee's own details are
-- exposed, and only to a holder of the unguessable token.
revoke all on function invitation_preview(text) from public;
grant execute on function invitation_preview(text) to anon, authenticated;

comment on function invitation_preview(text) is
  'Unauthenticated peek at one invitation, by token hash. Returns the INVITING ORG''S branding so the acceptance page can present the brand the invitee was actually invited by.';
