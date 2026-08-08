# Day 12 — Multi-role UAT script

**For:** TFML and OEA staff, plus one real vendor and one real tenant if
possible. **Duration:** roughly 3 hours across all ten roles.

> **Run this on the PRODUCTION environment**, before any live client is
> onboarded onto it — `GO_LIVE_CHECKLIST.md` §1. Rehearsal data is fine;
> a rehearsal *environment* is not, because the thing being tested is the
> environment.

---

## How to use this

Each row is one action with one observable result. Mark **P** (pass), **F**
(fail) or **N/A**. **A fail is not a blocker by itself** — record it, keep
going, and let the board weigh the list at the end. Stopping at the first fail
produces a report about one problem instead of a picture of the system.

⚠️ **The "must refuse" rows matter as much as the rest.** Half the value of this
script is confirming the system says *no* to the right people. A tester who
skips those because "it's obviously not allowed" has tested nothing — every one
of them was a real defect at some point in this build.

**Before you start:** confirm the environment is the production one, and that
the database is clean (schema only, no synthetic rows) — the Day 12 exit gate.

---

## A · Administrator (2 people: TFML admin, OEA admin)

| # | Action | Expected | P/F |
|---|---|---|---|
| A1 | Sign in at `/o/tfml` | TFML branding: navy, TFML logo, "TFML Portal" | |
| A2 | Open `/o/oea` in a private window | OEA branding: red. **No trace of TFML** | |
| A3 | Settings → Branding, change the accent colour, save, reload | The portal repaints | |
| A4 | Settings → Permissions | Matrix visible, **read-only** — you cannot edit your own org's | |
| A5 | People → invite a facility manager by email | Invitation email arrives | |
| A6 | Accept the invitation in a private window | Lands in the correct org **and role** | |
| A7 | Settings → Payment Gate, set the approval threshold | Saves | |
| A8 | **Must refuse:** try to reach `/orgs` | Nothing listed — you are not the operator | |

## B · Facility / Properties Manager

| # | Action | Expected | P/F |
|---|---|---|---|
| B1 | Sign in; open Requests | Only properties assigned to you | |
| B2 | Properties → create a property (inline location/project/site) | Created **and immediately visible to you** | |
| B3 | Assets → add an asset; set "Serves" = property | Saves; appears on the register | |
| B4 | Assets → bulk import the CSV template with two bad rows | Preview shows each bad row **with a reason**; import is all-or-nothing | |
| B5 | Open a ticket → dispatch to a vendor | Vendor is notified | |
| B6 | Raise Work (planned maintenance, no reporter) | Ticket created against the property, not flagged for triage | |
| B7 | Payments → the **"awaiting service verification"** queue | Your invoices are listed | |
| B8 | Verify service on one | Moves to *verified* | |
| B9 | Reject another **with a reason** | Vendor is notified with your words | |
| B10 | Review a tenant application → **recommend** | Recorded with your reason | |
| B11 | **Must refuse:** approve that same application | Refused — the recommender cannot decide | |
| B12 | **Must refuse:** approve a payment | Refused — that is finance's | |
| B13 | **Must refuse:** open Client Funds | Refused | |

## C · Regional Manager

| # | Action | Expected | P/F |
|---|---|---|---|
| C1 | Sign in | Properties, Assets, Vendors, Leases **and People** all present | |
| C2 | Confirm scope | Only your region's properties | |
| C3 | Invite an ops staff member | Works, bounded to your region | |
| C4 | **Must refuse:** Service Charges in the menu | **Absent** — decision 9: nothing financial | |
| C5 | **Must refuse:** invite an administrator | Refused — admin invitation is non-delegable | |

## D · FM Ops Staff

| # | Action | Expected | P/F |
|---|---|---|---|
| D1 | Sign in | Lands on **My Jobs** | |
| D2 | Have an FM dispatch you a job | Appears, and you are notified on your chosen channel | |
| D3 | Acknowledge it | Status moves | |
| D4 | Add a photo | Uploads; visible on the work order | |
| D5 | **Must refuse:** any property register, vendor list or money screen | All absent | |

## E · Vendor

| # | Action | Expected | P/F |
|---|---|---|---|
| E1 | Apply through the public vendor form | Submits; **not payable until approved** | |
| E2 | Sign in after approval → My Work | Assigned jobs listed | |
| E3 | **Accept** a job from the list | Status → Acknowledged, button disappears | |
| E4 | **Decline** another, with a reason | Goes back to the team | |
| E5 | **Mark complete** | Team notified | |
| E6 | Submit an invoice against that job | Enters at *pending verification* | |
| E7 | Read the invoice's stage | Says **who holds it** ("with your facility manager…") | |
| E8 | After B9 rejects one: read it | **The reason is visible**, with "correct and resubmit" | |
| E9 | Resubmit a corrected invoice for the same job | Accepted | |
| E10 | **Must refuse:** submit a second invoice for a job that already has a live one | Refused | |
| E11 | **Must refuse:** invoice a job that is not yours | Refused | |

## F · Tenant / Resident

| # | Action | Expected | P/F |
|---|---|---|---|
| F1 | Send "hi" to the brand's WhatsApp number | Replies; **no ticket is created** | |
| F2 | Send a real problem ("no water on the 3rd floor since morning") | Ticket + reference; category and urgency look right | |
| F3 | Reply "it's urgent" | Priority updated, confirmed — **no duplicate ticket** | |
| F4 | Ask "what's the status?" | Answers about the same ticket | |
| F5 | Sign in → My Requests | The timeline: raised → acknowledged → assigned → completed | |
| F6 | Raise one through the portal | Appears alongside the WhatsApp ones | |
| F7 | My Rent → pay a demand | Paystack checkout; receipt; balance updates | |
| F8 | Statements | Charges and history | |
| F9 | Settings | Lands on **My Profile** — *not* an "administrator access required" refusal | |
| F10 | Settings → My Notifications: add a phone, enable WhatsApp | Saves; WhatsApp becomes selectable only once a number exists | |
| F11 | Rate a completed job | Score recorded | |
| F12 | **Must refuse:** any other tenant's request, or any money screen | All absent | |

## G · Finance Approver

| # | Action | Expected | P/F |
|---|---|---|---|
| G1 | Client Funds → Balances | Held covers owed, per currency | |
| G2 | Collections → raise a payment request | Checkout link produced | |
| G3 | Pay it in test mode | Posts to the ledger **once**; receipt matches | |
| G4 | Reconciliation → import a statement, run it | Zero variance on a clean file | |
| G5 | Import one with a planted discrepancy | **Flagged**, line reported unmatched | |
| G6 | Payments → select several and **batch approve** | Approved; one above your limit is refused **with its reason**, and the rest still go through | |
| G7 | Remit an approved payment | Transfer sent; remittance advice; ledger posted | |
| G8 | Payouts → send a landlord payout | Sends the **net** (fees already taken at collection) | |
| G9 | Reports → P&L for the year | Income and expense, **separated by currency** | |
| G10 | **Must refuse:** reopen a rejected invoice → then do it | Allowed **only** for you/admin; the invoice restarts at verification | |
| G11 | **Must refuse:** edit the permission matrix | Read-only | |

## H · Executive (MD / Managing Partner)

| # | Action | Expected | P/F |
|---|---|---|---|
| H1 | Sign in | Requests, Analytics, Properties, Vendors, **Client Funds** and **Audit Trail** all present | |
| H2 | Approve a payment **above** the threshold | **Allowed** — decision 9 | |
| H3 | Client Funds → Balances | Readable in full | |
| H4 | Audit Trail | Readable in full | |
| H5 | **Must refuse:** send a remittance | Refused — oversight authorises, finance disburses | |
| H6 | **Must refuse:** add a bank account | Refused | |

## I · Property Owner / Landlord

| # | Action | Expected | P/F |
|---|---|---|---|
| I1 | Sign in | Lands on **My Portfolio** | |
| I2 | Read the statement | Collected, fees, remitted, **still held** — per property | |
| I3 | Remittances to you | Every payout, with references | |
| I4 | Properties | Only the ones you own | |
| I5 | **Must refuse:** another landlord's property, or any vendor/payment screen | Absent | |

## J · Viewer

| # | Action | Expected | P/F |
|---|---|---|---|
| J1 | Sign in | **Programme Overview** only | |
| J2 | **Must refuse:** tickets, money, people | All absent | |

## K · Operator (OE Group platform admin)

| # | Action | Expected | P/F |
|---|---|---|---|
| K1 | Sign in at `/login` → `/orgs` | Every client organisation listed | |
| K2 | Provision a new org with a reason | Created; the reason is recorded | |
| K3 | Consolidated | Every org, grouped by brand, **per currency** | |
| K4 | Permissions → change a capability for one org | Takes effect **in that org only** | |
| K5 | Break-glass into an org | **That org's administrators are notified** | |
| K6 | **Must refuse:** grant yourself a role inside a client org | Refused | |

---

## L · Cross-cutting

| # | Action | Expected | P/F |
|---|---|---|---|
| L1 | On a phone, walk one full journey (tenant reports → FM dispatches → vendor completes) | Usable throughout on a small screen | |
| L2 | Switch to dark mode on three screens | Legible; nothing washed out | |
| L3 | Turn off wifi mid-journey, then back on | Recovers without losing what was typed | |
| L4 | Two people approve the same payment simultaneously | **One** approval, no error to the loser | |
| L5 | Refresh a checkout page twice after paying | Charged **once**; the ledger shows one entry | |

---

## Sign-off

| | Name | Date | Result |
|---|---|---|---|
| UAT lead | | | |
| TFML representative | | | |
| OEA representative | | | |
| Board go / no-go | | | |

**Fails recorded:** ______  **Blocking (board's judgement):** ______
