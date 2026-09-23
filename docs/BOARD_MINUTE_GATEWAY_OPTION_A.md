# Board minute — payment gateway, Option A

**Draft for adoption. Not yet signed.** Prepared 23 September 2026 to record a
decision the board has already taken, so that it exists in writing. Nothing in
this file is evidence that the board has approved it; the sign-off block at the
foot is empty until a director completes it.

**Subject:** amendment of locked decision 4 (Payments) of the OE Group IPMS
build constitution
**Prepared by:** J. Amapakabo, ICT Manager
**Decision reference:** go-live build plan 1.10 and 2.12

---

## 1. Why this minute is needed

Locked decision 4 of `claude.md` reads:

> **Payments:** **Paystack** (Collections + Transfers/remittance) **+
> Flutterwave** (FX / international collections) — multi-currency retained.

That is no longer what the system does. The code was changed on 23 September
2026 (PR #53, merged) so that Naira collections prefer Flutterwave. A locked
decision is not amended by a pull request, so the document was deliberately left
untouched pending this minute. **Until it is adopted, the constitution and the
code disagree** — and the constitution is what every subsequent build session
reads first.

## 2. What changed, and why

**Paystack's business verification cannot be passed in the time available.** It
requires a SCUML certificate and the identification and residential address of
every shareholder holding 51% or more. Flutterwave's verification can be passed,
and a single Flutterwave account takes both Naira and foreign currency.

The board's cutover deck set this out as **Option A**, and Option A is what has
been built:

| | Naira | Other currencies |
|---|---|---|
| **Collections** | Flutterwave first; Paystack only where Flutterwave is not connected | Flutterwave (unchanged since Day 5) |
| **Payouts** | Paystack only | None — refused, and the officer is directed to a recorded bank transfer |

**This is a preference, not a replacement.** No organisation's behaviour changes
until a Flutterwave key exists for it. An organisation whose only connected key
is Paystack continues exactly as before.

**Payouts do not reach Flutterwave at all.** The Flutterwave adapter collects and
refuses to transfer. Where no Paystack account exists the payout is refused
*before* the remittance is claimed, and the officer is directed to "Record a bank
transfer", which passes through the same approval gate as an automated payout.
Automated Flutterwave payouts are the first post-go-live item (Option B).

## 3. The amendment proposed

That locked decision 4 be amended to read:

> **4. Payments:** **Flutterwave** (collections — Naira and foreign currency) **+
> **Paystack** (payouts/remittance, and Naira collections only where Flutterwave
> is not connected) — multi-currency retained. Amended 23 September 2026 by board
> minute, superseding the original Paystack-primary split; Paystack's business
> verification could not be met in the time available. Automated Flutterwave
> payouts are deferred to Option B, post-go-live.

And, consequentially, that the two supporting lines in the same document be
brought into line: the Module 4 tooling note and the commercial model table,
both of which still name the Paystack Transfers API as the outbound path.

## 4. What the board is being asked to accept

1. **Payouts are manual at go-live.** Unless a verified Paystack account exists,
   every vendor and landlord payment leaves by bank transfer, made from the
   organisation's own bank and recorded against the approval that authorised it.
   The approval chain, the maker-checker rule and the audit trail are unchanged;
   what changes is that a person makes the transfer.
2. **A live Flutterwave secret key and webhook secret hash are a hard gate on
   go-live.** Without them production collects nothing. This is build plan item
   1.8, reassigned from Paystack to Flutterwave.
3. **Flutterwave requires the merchant's website to carry a terms of service and
   a refund policy** before it will reactivate the account. Those pages have been
   built and merged (PR #56). The account reactivation itself is outstanding.
4. **The dependency runs one way and cannot be reordered:** legal pages →
   Flutterwave reactivation → live keys → production collections.

## 5. Risks recorded

- **Single point of failure.** With Paystack unverified, Flutterwave is the only
  route by which money can be collected online. A Flutterwave outage stops card
  collection entirely; bank transfer into the segregated client-funds account
  (locked decision 2) remains available throughout and is already a first-class
  path in the product.
- **Payout volume is manual.** The load falls on the payment officers. This is
  the principal argument for building Option B soon after go-live.
- **Fee structure is not compared here.** The board may wish to note that the
  choice was driven by verification feasibility against a fixed date, not by
  price.

## 6. Resolution

> **RESOLVED**, that locked decision 4 of the OE Group IPMS build constitution be
> amended as set out at section 3 above; that Flutterwave be adopted as the
> collections gateway for both Naira and foreign currency; that payouts remain on
> Paystack where available and otherwise proceed by recorded bank transfer under
> the existing approval controls; and that automated Flutterwave payouts be
> scheduled as the first post-go-live development item.

---

| | |
|---|---|
| **Date of meeting** | |
| **Present** | |
| **Proposed by** | |
| **Seconded by** | |
| **Signature** | |

*Once signed, record the date here, amend `claude.md` decision 4 to the text at
section 3, and tick build plan 1.10.*
