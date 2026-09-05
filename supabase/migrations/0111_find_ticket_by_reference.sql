-- Finding a request by the reference the reporter was actually given.
--
-- Every acknowledgement a tenant receives — on WhatsApp, on Telegram, on the
-- portal — names the request by `shortRef()`: the first eight hex characters
-- of its id, uppercased ("C1AF0AF7"). That string is what a person quotes
-- back when they ring up or reply. It was, until now, the one thing the
-- dashboard could not be searched by: the requests list filtered on summary,
-- message text, property and category, and the reference was not displayed on
-- the row either, so it could not even be matched by eye.
--
-- ⚠️ The subtler half, and the reason this is a database function rather than
-- one more clause in the client-side filter. The requests page loads the 200
-- most recent tickets and narrows them in the browser. A reference older than
-- that window would match nothing, and the screen would say "No matching
-- requests" — which is not "it is not in this page", it reads as "it does not
-- exist". For someone holding a reference from a months-old WhatsApp thread
-- that is a wrong answer delivered confidently. This searches the whole table
-- so the honest answer is always available.
--
-- SECURITY INVOKER (the default — deliberately NOT definer): `tickets_select`
-- applies in full, so this can only ever return rows the caller could already
-- have reached by scrolling. It makes an existing row findable; it never makes
-- a new one visible.
create or replace function find_tickets_by_reference(p_ref text)
returns setof tickets
language sql stable set search_path = public as $$
  select t.*
    from tickets t
   where p_ref is not null
     and length(regexp_replace(p_ref, '[^0-9A-Fa-f]', '', 'g')) >= 4
     -- Dashes stripped from BOTH sides, so a pasted full UUID
     -- (c1af0af7-1c2d-…) and a quoted short ref (C1AF0AF7) are the same
     -- query. Case-folded for the same reason: nobody retypes a reference in
     -- the case it was printed in.
     and replace(t.id::text, '-', '')
         like lower(regexp_replace(p_ref, '[^0-9A-Fa-f]', '', 'g')) || '%'
   order by t.created_at desc
   limit 20;
$$;

revoke all on function find_tickets_by_reference(text) from public;
grant execute on function find_tickets_by_reference(text) to authenticated;

comment on function find_tickets_by_reference is
  'Finds requests whose id starts with a quoted reference — the shortRef() a reporter is given in their acknowledgement. Searches the whole table rather than the page the dashboard happens to have loaded, so an older reference is found rather than reported as non-existent. SECURITY INVOKER: tickets_select applies, so it can only surface rows the caller could already reach.';
