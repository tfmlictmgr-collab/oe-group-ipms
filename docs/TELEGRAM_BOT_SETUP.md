# Telegram bots — setup guide

Two bots, one per brand. TFML tenants talk to the TFML bot, OEA tenants to the
OEA bot, and neither ever sees the other's requests.

These are **client-facing**. A tenant reporting a burst pipe at 11pm sees this
bot's name and picture, and nothing else tells them they're in the right place —
so the naming below is not decoration.

> **Why two bots and not one?** Telegram issues one token per bot, and the token
> IS the identity a reply is sent from. One shared bot would mean an OEA tenant
> receiving answers from a facilities-management bot they've never heard of —
> the same fault we hit on WhatsApp, where every reply left from the TFML number.

---

## 0. What is actually registered

The tables below are the *suggestions* this guide was written with. Both bots
now exist, and TFML's did not take the first-choice username — so this block,
not the table, is what to publish to tenants. Read live from Telegram's own
`getMe` on 2026-08-20, not from the label stored beside the token:

| Brand | Username | Display name |
|---|---|---|
| TFML | **`@tfml_support_bot`** | Total Facilities Management Limited (TFML) |
| OEA | **`@oea_properties_bot`** | Ora Egbunike & Associates |

⚠️ Publishing the wrong handle is worse than publishing none: `@tfml_facilities_bot`
(this guide's original first choice) is not ours, and a tenant who finds
*something* at a plausible-looking username has no way to tell. To re-confirm
either at any time, ask Telegram rather than any record we keep:

```bash
curl -s "https://api.telegram.org/bot<token>/getMe"
```

---

## 1. Create each bot in BotFather

Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and
answer two questions.

### Display name
Shown at the top of the chat. Spaces and full company names are fine, and it can
be changed later.

| Brand | Use |
|---|---|
| TFML | `TFML Facilities` |
| OEA | `Ora Egbunike & Associates` |

Avoid "Bot", "Support Bot" or "Assistant" in the display name. People are more
forthcoming with a service than with a robot, and the intake quality shows it.

### Username
Permanent-ish, must be unique across all of Telegram, must end in `bot`. This is
what gets printed on notices and put in a WhatsApp broadcast, so short and
obviously legitimate beats clever.

| Brand | First choice | Fallbacks if taken |
|---|---|---|
| TFML | `@tfml_facilities_bot` | `@tfml_ng_bot`, `@tfmlcare_bot` |
| OEA | `@oea_properties_bot` | `@oraegbunike_bot`, `@oeacare_bot` |

**Do not** register something generic like `@facilities_bot` or `@rentbot`. An
unbranded username is indistinguishable from an impersonator, and you cannot
prove ownership of a name that doesn't carry yours.

BotFather replies with a token that looks like
`8123456789:AAF-3xY...`. **That token can send messages as your business.**
Treat it like a password: don't paste it into chat, email or a ticket. You will
paste it once, into the command in step 3.

---

## 2. Set the public face

Still in BotFather, for **each** bot. All are `/command` → pick the bot → give
the value.

**`/setdescription`** — shown on the empty chat screen, before anyone sends
anything. This is your one chance to set expectations:

> TFML Facilities — report a maintenance issue, check a job you've already
> reported, or ask about your service charge. Messages are logged and answered by
> the facilities team. For a life-threatening emergency, call your building's
> emergency line instead.

> Ora Egbunike & Associates — report a property issue, check a request you've
> already made, or ask about rent and statements. Messages are logged and
> answered by the property team.

That last line on the TFML one matters. A chat channel invites emergencies, and
it must not be mistaken for one.

**`/setabouttext`** — the short line on the bot's profile card (120 chars):

> Official maintenance and service-charge channel for TFML-managed properties.

> Official property, rent and maintenance channel for OEA-managed properties.

**`/setuserpic`** — the brand logo. Square, at least 512×512. **Do this.** An
unset picture shows a grey placeholder, which is exactly what a scam account
looks like, and it is the single strongest signal of legitimacy a tenant has.

**`/setcommands`** — the menu behind the "/" button:

```
start - Begin, or see what this channel can do
status - Check a request you've already reported
help - How to reach a person
```

**`/setjoingroups`** → **Disable.** These are one-to-one channels. A bot added to
a group would log every message in it as service requests.

**`/setprivacy`** → **Enable** (the default). Irrelevant while groups are off,
but it means the bot cannot read unrelated group chatter if that ever changes.

---

## 3. Register it with the system

One command per bot, from the project directory. This generates a fresh webhook
secret, stores the route, points Telegram at our endpoint, and reads the setting
back to confirm Telegram agrees:

```bash
node scripts/register-telegram-bot.mjs TFML <paste-the-token>
```

```bash
node scripts/register-telegram-bot.mjs OEA <paste-the-token>
```

You should see:

```
Bot: @tfml_facilities_bot (TFML Facilities)
Org: TFML — Total Facilities Management Limited

✓ route stored (secret + bot token)
✓ webhook set → https://oe-group-ipms-dev.vercel.app/api/webhooks/telegram
✓ confirmed by Telegram (pending: 0)
```

The token is written only to `channel_routes`, which is service-role-only — no
portal user, of any role, can read it (migration `0039`).

Re-running the command rotates the secret and replaces the route. Do that if a
token is ever exposed; also send BotFather `/revoke` to invalidate the token
itself.

---

## 4. Check it

Message each bot. You should get:

- an acknowledgement naming the request's category and priority
- two buttons: **📋 Check status** and **🚨 It's urgent**
- the request appearing in **that brand's** portal, not the other's

Tapping **Check status** returns the request's current state. Tapping
**It's urgent** raises its priority and flags it for a person — deliberately
*not* straight to critical, since that grade drives SLA and callout cost, and a
reporter marking their own request is a signal rather than a decision.

Then the test that matters: message the **other** brand's bot and confirm the
reply comes from that bot, and that neither request appears in the other
portal's dashboard.

---

## Notes

**Anyone can message a bot.** Telegram has no equivalent of WhatsApp's
24-hour session window, and there is no approval step — a stranger who finds the
username can open a chat. Intake is rate-limited per sender, and every message
becomes a classified ticket in the routed org, but the channel is open by
design. Publish the usernames to tenants deliberately rather than assuming
obscurity.

**Telegram is a parallel channel, not part of the B8 fallback cascade.** It runs
alongside WhatsApp → SMS → Email for people who opt in, and never substitutes for
them — so a Telegram failure never suppresses a critical notification.

**Changing the display name, description or picture is instant** and needs no
redeploy. Only the token and the webhook go through the registration command.
