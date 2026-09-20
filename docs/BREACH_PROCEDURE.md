# Personal data breach procedure — OE Group IPMS

**Status:** working document, drafted 2026-09-20. Approved by Joseph Emmanuel
(ICT) as the working procedure pending DPO and Legal review.
**Owner:** DPO — **Ebube Ikechwu**. **Closes:** `GO_LIVE_BUILD_PLAN.md` 1.3.

> **Print this.** It is written to be used at 3am by whoever is awake, not read
> in advance. If you are reading it because something has happened, start at §2.

---

## 1. What counts

A personal data breach is **any** security failure leading to accidental or
unlawful destruction, loss, alteration, unauthorised disclosure of, or access
to personal data. It does not have to be malicious and it does not have to be
large.

Examples that count here:

- A tenant, vendor or staff member can see records belonging to another
  organisation, or to another tenant. **An RLS failure is a breach.**
- The `SUPABASE_SERVICE_ROLE_KEY` is exposed anywhere outside a secret store —
  a screenshot, a chat message, a commit, a log line.
- An account is accessed by someone other than its holder.
- An export, statement or attachment reaches the wrong recipient.
- Data is destroyed or corrupted without a recoverable backup.

**Not a breach:** a failed login, a refused permission, a suite reporting a
control working. Those are the system doing its job.

---

## 2. The clock

⏱️ **It starts the moment anyone at OE Group becomes aware — not when it is
confirmed, understood, or fixed.**

| Deadline | Obligation |
|---|---|
| **Immediately** | Tell the DPO. Do not wait to be certain. |
| **72 hours** from awareness | Notify the **NDPC**, where the breach is likely to result in a risk to people's rights and freedoms (NDPA s.40(2)). |
| **Immediately**, in parallel | Tell affected **data subjects**, where the breach is likely to result in a **high risk** to them — with the steps they can take to protect themselves. |

📌 **You do not need the full picture to notify.** NDPA s.40(2) expressly
permits phased reporting where it is not possible to provide everything at
once. **Late and complete is worse than early and partial.**

---

## 3. First 60 minutes — contain

Do these in order. Do not investigate first.

1. **Tell the DPO and the ICT manager.** Phone, not email.
2. **Stop the bleeding.**
   - Suspected credential exposure → rotate it *now* in Supabase and Vercel.
     ⚠️ `GATEWAY_CREDENTIAL_KEY` is **not** recoverable if lost — read
     `GO_LIVE_CHECKLIST.md` before touching that one.
   - Suspected account compromise → deactivate the account. It stays in the
     trail; deactivation is the correct action, not deletion.
   - Suspected RLS or access-control failure → take the affected surface down
     rather than leave it serving wrong data.
3. **Do not delete anything.** Not logs, not rows, not messages. See §4.
4. **Write down the time you became aware.** That timestamp is the start of
   every deadline in §2 and you will be asked for it.

---

## 4. ⚠️ Preserve the evidence — the system already does most of it

`audit_log` is **append-only by database trigger**, and
`audit_log_actor_id_fkey` prevents deleting a user the trail still names. This
is deliberate, and in a breach it works in your favour: **the record of who did
what cannot be quietly altered, including by whoever caused the breach.**

Do not attempt to work around it. Do not delete users to "clean up" — deactivate
them. An investigator who finds an intact trail is in a very different
conversation from one who finds gaps.

Also preserve: Sentry events, Vercel deployment and function logs, Supabase logs
(note their retention window — capture what you need before it rolls off).

---

## 5. By hour 12 — assess

The DPO decides, and records the reasoning:

| Question | Why it matters |
|---|---|
| What data, and whose? | Drives whether it is reportable and to whom |
| How many people? | Approximate is acceptable |
| Special-category data involved? | Raises it to high risk almost automatically |
| Financial data — bank details, payment records? | High risk |
| Is it contained, or still live? | Changes what you tell people to do |
| Could this cause real harm — fraud, eviction, reputational damage? | This is the **high risk** test for §2 |

**If in doubt, notify.** The cost of an unnecessary notification is paperwork.
The cost of a missed one is a regulatory finding plus the loss of the argument
that you take this seriously.

---

## 6. By hour 72 — notify the NDPC

Send from the DPO. Include what you have; say plainly what you do not yet have
and when you will follow up.

> **Subject:** Personal data breach notification — [Organisation], [date]
>
> 1. **Nature of the breach:** what happened, in plain words.
> 2. **Categories and approximate number of data subjects** affected.
> 3. **Categories and approximate number of records** affected.
> 4. **DPO contact:** Ebube Ikechwu, [contact].
> 5. **Likely consequences** for the people affected.
> 6. **Measures taken or proposed** — containment, and what prevents recurrence.
> 7. **Whether data subjects have been told**, and if not, why not.
> 8. **What is still unknown**, and when you will report further.

---

## 7. Telling the people affected

Required where the breach is likely to result in a **high risk** to them.
Write it for the person, not for the regulator:

- What happened, and when.
- What data of theirs was involved.
- What you have done about it.
- **What they should do** — change a password, watch for a specific scam,
  check their statement.
- Who to contact.

❌ Never: "we take your privacy seriously", "an incident occurred", "may have
been affected" when you know they were. People act on clear information and
ignore reassurance.

---

## 8. Afterwards — within 14 days

1. **Record it in the breach register** (§9). Every breach goes in, including
   ones you decided not to report, **with the reason for that decision**. The
   register is what demonstrates judgement was exercised rather than skipped.
2. **Fix the cause, and prove the fix.** Where the cause is in code, that means
   a migration or a change plus a suite that fails without it — the convention
   the whole `scripts/verify-*` tree already follows.
3. **Update this document** if the procedure did not survive contact.

---

## 9. Breach register

Kept by the DPO. One row per incident, never deleted.

| # | Date aware | What happened | Data & people affected | Risk | NDPC notified? | Subjects notified? | If not, why | Fix + proof | Closed |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

---

## 10. Contacts

| Role | Name | Contact |
|---|---|---|
| DPO | Ebube Ikechwu | **[to be completed before publishing]** |
| ICT manager | Joseph Emmanuel | **[to be completed]** |
| NDPC | Nigeria Data Protection Commission | **[to be confirmed by Legal]** |
| Legal | | **[to be completed]** |

⚠️ **This document is not finished until that table is.** A procedure whose
first step is "tell the DPO" fails at 3am if nobody can find the number.
