# Reaching the org on WhatsApp and Telegram — without handing out a number

**Date:** 2026-08-10 · **By:** PC2 · **Status:** code written, migrations
**not applied**, one real finding for PC1 (§4).

The goal: a tenant, vendor or applicant should never have to read, type, dial
or save a phone number to reach TFML or OEA. They tap something in the portal
and the conversation opens, already addressed and already introduced.

---

## 1. The constraint this is built around

**The WhatsApp Business Platform has no number masking.** There is no
Uber-style proxy that gives each conversation a disposable number while the
real one stays hidden. Every inbound message lands on a real, WABA-registered
number — for us, TFML `+234 703 689 1329` and OEA `+234 708 471 4148`
(`WHATSAPP_360DIALOG_MIGRATION.md`). Any vendor claiming to mask numbers is
either describing click-to-chat or running something off-spec, and off-spec
gets the WABA banned — not a position to be in with a system holding KYC
documents and moving client money.

So the number is not hidden. It is simply never something a **person** handles.
That distinction is the whole design: the number becomes an implementation
detail, the way the mailbox behind a "Contact us" link is.

The one discipline this requires: **do not print the bare number as copyable
text** on public marketing, flyers or the website. The moment it is printed, it
becomes something to save into contacts — and a saved number goes stale
silently when a channel is re-provisioned, while a link in the portal does not.

---

## 2. Where the identifiers live, and why not in `channel_routes`

This is the part worth reading before touching any of it.

Each channel has **two** identifiers, and only one of them is publishable:

| Channel | Public — display/deep-link | Secret — authority |
|---|---|---|
| WhatsApp | the E.164 number (`2347036891329`) | the per-channel **webhook token** |
| Telegram | the bot **username** (`@tfml_support_bot`) | the bot **token** |

Both secrets live in `channel_routes.external_id` / `outbound_token`, and
**0039 removed every RLS policy and grant on that table** after the viewer-access
verification found a tenant could read it. Its comment is explicit: *"Do not add
a SELECT policy without re-reading 0039."* For Telegram the token is the
authentication and the routing key at once; since the 360dialog migration the
same is now true of WhatsApp's webhook token, because direct 360dialog clients
receive no request signature of any kind.

That table therefore **cannot** be the source for a deep link — no UI can read
it, and it must stay that way.

So the two public identifiers go on `orgs`, beside the existing 0015 branding
columns (`support_phone`, `support_email`) they are siblings of:

- **`0146`** — `orgs.whatsapp_number`, E.164 without the leading `+`, with a
  CHECK constraint (`^[1-9][0-9]{6,14}$`).
- **`0147`** — `orgs.telegram_bot_username`, no `@`, with a CHECK enforcing
  Telegram's own rule (5–32 chars, ends in `bot`) — because the likeliest bad
  value is not an attack but an admin pasting a personal handle, which would
  point every "chat with us" button at a stranger.

Leaking either of these does nothing; they are on the brand's own signage.
Leaking what is in `channel_routes` hands over inbound trust for the brand.

---

## 3. What was built

| File | What it does |
|---|---|
| `lib/whatsapp-link.ts` | `wa.me` builder + E.164 normaliser (accepts `+234 …`, `0703 …`), prefilled-message helpers |
| `lib/telegram-link.ts` | `t.me` builder + username normaliser, `?start=` payload validation |
| `components/patterns/chat-with-us.tsx` | Server Component rendering one or both buttons; renders **nothing** when an org has neither channel |
| `app/dashboard/my-requests/page.tsx` | page-level panel — general, no reference |
| `app/dashboard/tickets/[id]/page.tsx` | reference-scoped, shown to the requester only |
| `lib/brands.ts`, `lib/auth.ts` | both values flow through the existing brand-theme pipeline, normalised again on read |
| Settings → Portal text | two admin-editable fields, rejecting invalid values rather than silently dropping them |

Two deliberate choices inside `ChatWithUs`:

- It renders **no number as text** — see §1.
- Telegram degrades to nothing rather than a dead link. That is the expected
  state for both live orgs today: **the TFML and OEA bots are still uncreated
  in @BotFather** (`GO_LIVE_CHECKLIST.md` §1). The column existing first means
  bringing them online is a settings entry, not a deploy.

### The Telegram `?start=` payload is not authorisation

It carries the human-facing ticket reference (`TFML-1042`) — visible in the URL,
guessable by design, trivially editable before sending. It is a hint about what
the conversation is about, nothing more. The handler must still resolve it
inside the org the webhook authenticated, and still check the sender is
entitled to see it. This is the rule `lib/notify.ts` already states for
Telegram callback data: *"A button is a suggestion, never an authorisation."*

---

## 4. ⚠️ Finding — proactive WhatsApp messages need a template, and we have none

Found while building the business-initiated half. **Not introduced by this
work; surfaced by it.**

WhatsApp permits free-form text only inside a **24-hour customer service
window** opened by the *person* messaging the org. Outside that window — which
is every message *we* initiate to someone who has not written in today — a
`type: "text"` send is **rejected by the API**. It does not degrade and it does
not queue.

`lib/notify.ts`'s `sendWhatsApp` only ever sent `type: "text"`, and
`lib/cascade.ts` → `sendCascade` routes proactive notifications through it.
Round-trip testing never caught this because a round trip is *by definition*
inside the window.

**Severity is limited, and worth stating precisely:** `tryWhatsApp` already
treats a send failure as a failed attempt and the cascade falls through to SMS
then email, which is the intended B8 behaviour for an unavailable channel. So
nothing is lost — but every out-of-window WhatsApp notification is logged as
`failed` and the recipient gets email instead of the channel they expect.

**Added:** `sendWhatsAppTemplate()` in `lib/notify.ts` — sends a pre-approved
template with ordered `{{1}}`, `{{2}}` … variables.

**Still needed, and it is not a code change:**

1. Register and get approval for the templates in the **360dialog Hub**, per
   business (TFML and OEA are separate businesses with separate keys, so
   approval is needed twice). Approval takes minutes to about a day.
2. Decide which notifications are genuinely business-initiated — payment
   received, application decision, work-order scheduled — and route those
   through `sendWhatsAppTemplate` rather than `sendReply`.
3. Keep `sendReply` for replies *within* a conversation, which is what it is
   correct for.

Until (1) exists, there is nothing to route to, which is why this change stops
at the plumbing. **The copy for all four templates is drafted and ready to
submit — `WHATSAPP_TEMPLATES.md`.**

**Telegram has no equivalent restriction** — a bot may message any user who has
ever started it, with no window and no template approval. So the
business-initiated path is available on Telegram the moment the bots exist.

---

## 5. Not done

- **Migrations `0146`/`0147` are written but NOT applied.** Dev and prod still
  share one Supabase project, so PC1 should apply these deliberately rather
  than have them arrive as a side effect.
- **The public application page (`/apply/[orgId]`) has no chat affordance**, and
  adding one is not a one-liner. It renders from `vendor_application_org`, an
  RPC that deliberately returns only `org_name` and `delivery_brand` so the page
  "cannot be used to discover orgs" — so the brand theme it builds has no
  WhatsApp number in it. Placing `ChatWithUs` there means extending that RPC to
  return the two public handles. Defensible (both are non-secret, and the RPC
  already only answers for orgs that opted in), but it widens a surface written
  narrow on purpose, so it is left as a deliberate decision rather than taken.
- **QR codes** (scan-to-chat on office signage and at properties) encode the
  same `wa.me` / `t.me` URL these helpers already build. No new mechanism, just
  a generator — deliberately left out to keep this change to one idea.
