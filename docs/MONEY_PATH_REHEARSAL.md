# 4.4: Money-path rehearsal (staging)

**What it proves:** one real-shaped payment goes in and out of the system the way
it will for go-live. There is **no gateway** (Flutterwave waits for 1.8), so the
money moves by hand:

1. **In:** a tenant reports a rent payment made by bank transfer, with proof.
   Three desks confirm it, and the last one posts it to the ledger.
2. **Reconciled:** the bank statement line matches the ledger entry.
3. **Out:** the landlord's share is paid by bank transfer. First the landlord
   sends their own bank evidence. The payout then climbs the approval chain,
   and the Payment Officer records the transfer.
4. **Told:** the tenant has a receipt and the landlord has a remittance advice.

**Where:** staging only, `https://oe-group-ipms-staging.vercel.app`. **Never production.**
**Time:** about 90 minutes. **Org:** OEA. Its chain is the one the board set for
both directions, so it is the stricter of the two.

Written 26 Sept 2026 against `v1.0.0-rc7`, from the code: 0281/0282/0293
(money in), 0289/0296 (money out), `payment_chain_stages` (the OEA ladder).

---

## 0. Before you start

- **Don't run `npm run verify` during this.** It checks staging's data and would
  trip over yours.
- **Logins:** the staging fixtures below. They share one password, which is in
  `scripts/seed-brand-roles.mjs` (`PASSWORD`). Don't paste it into chat.
  Use **one private window per person**, and sign out between people.

  | Who | Login | Role | Does |
  |---|---|---|---|
  | Tenant | `oea.tenant@oegroup.test` | tenant (Kelechi Umeh) | reports the payment |
  | Auditor | `oea.auditapprover@oegroup.test` | payment audit approver | desk 1, in and out |
  | Managing Partner | `oea.executive@oegroup.test` | executive | desk 2, in and out |
  | Payment Approver | `oea.approver@oegroup.test` | payment approver | desk 3: posts money **in**, final approval **out** |
  | Payment Officer | `oea.finance@oegroup.test` | finance approver | raises and **sends** money out |
  | Administrator | `oea.admin@oegroup.test` | admin | confirms the landlord's bank evidence |
  | Landlord | `oea.owner@oegroup.test` | property owner (Ifeoma Duru) | receives the payout |

- **Two small files:** any PDF or photo will do as the tenant's "proof" and the
  officer's "bank confirmation", **5 MB or less** (PDF, JPG, PNG, WEBP, HEIC).
  For example, a phone photo of a note that says *TEST 4.4*. **No real bank
  documents.**
- **Amount:** use **₦50,000** throughout, so every later screen has a number you
  can recognise.
- **Record as you go** in `docs/verify-runs/money-path-<YYYYMMDD>.md`, using the
  table in §6.
- **Emails won't arrive on staging.** Its Resend key is invalid, and the fixture
  inboxes aren't real. Anything that would be emailed has a **Copy** button or
  appears in the app instead. That's expected, not a finding.

---

## 1. Money in: the tenant reports a transfer

### 1.1 The tenant sees where to pay (as `oea.tenant`)

**My Rent** → find a demand that isn't fully paid → **Bank transfer / pay another way**.

| Check | Expect |
|---|---|
| 1.1a | The form opens with that demand already chosen |
| 1.1b | **Transfer to** shows **OEA's** client-funds account and **nothing of TFML's** (B1) |

If My Rent shows no unpaid demand, stop and tell me. Earlier test runs may have
paid it, and I'll give you the one command that raises a fresh one.

### 1.2 The tenant reports it

- **How you paid:** Bank transfer.
- **Date you paid:** today.
- **Your bank/teller reference:** `TEST-44-IN`.
- **Your bank / Your account number / name:** any test values.
- **What the payment is for:** **₦50,000** against the demand. A part payment
  is allowed.
- **Anything else we should know:** `4.4 rehearsal`.

| Check | Do | Expect |
|---|---|---|
| 1.2a | Try **Send for checking** *before* attaching a file | refused: *"Attach your proof of payment to continue."* |
| 1.2b | Attach the proof, then **Send for checking** | accepted, and the claim is listed as waiting to be checked |
| 1.2c | Back on **My Rent** | the demand is **unchanged**. A claim moves no money until it is confirmed (0281) |

### 1.3 Desk 1: audit (as `oea.auditapprover`)

**Off-platform payments** → the claim.

| Check | Do | Expect |
|---|---|---|
| 1.3a | Open the proof | it opens, and it's the file the tenant sent |
| 1.3b | Confirmation panel | Stage 1 shows **Here now**; stages 2 and 3 are waiting |
| 1.3c | **Confirm** | *"Confirmed. It has moved to the next desk."* |

### 1.4 Out-of-order check (as `oea.approver`, before the executive)

| Check | Do | Expect |
|---|---|---|
| 1.4a | Look for the same claim | either it isn't offered to them yet, or it opens with **no** confirm button. It's the executive's turn, and desks can't be skipped |

### 1.5 Desk 2: Managing Partner (as `oea.executive`)

| Check | Do | Expect |
|---|---|---|
| 1.5a | **Confirm** | *"Confirmed. It has moved to the next desk."* |

### 1.6 Desk 3: Payment Approver posts it (as `oea.approver`)

| Check | Do | Expect |
|---|---|---|
| 1.6a | The button | reads **Confirm and post to the ledger** |
| 1.6b | Press it | *"Confirmed and posted to the ledger."* |
| 1.6c | The claim page | a **Receipt** button; it opens a receipt for **₦50,000** in **OEA's** name |

### 1.7 The tenant sees the result (as `oea.tenant`)

| Check | Expect |
|---|---|
| 1.7a | **My Rent:** the demand's balance is **₦50,000 lower**, and it reads part-paid (or paid, if ₦50,000 cleared it) |
| 1.7b | The receipt is reachable from the claim, in OEA's name only |

### 1.8 A refused claim moves nothing (as `oea.tenant`, then `oea.auditapprover`)

Report a second payment exactly as in 1.2, but for **₦10,000** with reference
`TEST-44-BAD`.

| Check | Do | Expect |
|---|---|---|
| 1.8a | Auditor: **Send back for correction** with the reason `short` | refused. A reason needs **10 characters or more** |
| 1.8b | Auditor: **Not accepted**, with the reason `4.4 rehearsal: refused on purpose` | recorded |
| 1.8c | Tenant, **My Rent** | the balance is **unchanged** by the ₦10,000 |

---

## 2. Reconcile it (as `oea.approver`)

**Ledger → Reconciliation**

1. Press **Template** and open the CSV in Excel.
2. Delete the guidance and example rows, and add **one** line:

   | date | description | reference | amount | debit | credit | external_id |
   |---|---|---|---|---|---|---|
   | *today, YYYY-MM-DD* | `TRF FROM KELECHI UMEH - RENT TEST` | `TEST-44-IN` | | | `50000` | `TEST44IN1` |

3. Save it as CSV, then **Choose statement file** → **Import 1 line** →
   **Auto-match** → set **As at** to today → **Run reconciliation**.

| Check | Expect |
|---|---|
| 2a | **Auto-match:** *"Matched 1 line(s)"*. The statement credit found the ₦50,000 collection by itself |
| 2b | Importing the same file again adds nothing. The bank reference makes re-importing safe |
| 2c | **Run reconciliation:** **Balanced**, or a variance. ⚠️ Staging's ledger holds months of test history (the unexplained ₦7.56M among it), so a variance here can be old. **Write the variance down.** The pass condition is 2a. |

---

## 3. Money out: the landlord is paid by bank transfer

### 3.1 The landlord's money is waiting (as `oea.finance`)

**Ledger → Payouts** → **Held for landlords**.

| Check | Expect |
|---|---|
| 3.1a | The landlord of Kelechi's unit (Ifeoma Duru) is listed, and the amount **includes** the ₦50,000 **net of the management fee**. Earlier staging collections may add to it |
| 3.1b | If it says *"No way to pay them yet"*, go to 3.2. If a confirmed bank-transfer account is already on file, note that and skip to 3.4 |

### 3.2 Ask the landlord for their bank details (as `oea.finance`)

In the landlord's bank-details panel: **Send the link** → **Copy** the link it shows.

| Check | Do | Expect |
|---|---|---|
| 3.2a | Open the copied link in a **new private window**, signed out | a page asking for the landlord's bank details, with the org's name and no one else's |
| 3.2b | Fill in a test bank and account name, attach the test document, submit | accepted |
| 3.2c | Open the **same link** again | refused, because the link is spent. It must say nothing about who or what it was for (the same standard as self-assessment A5) |

### 3.3 Someone else checks the evidence (as `oea.admin`)

**Ledger → Payouts** → the landlord's bank details → **Open the document** →
**I have checked the document**.

| Check | Expect |
|---|---|
| 3.3a | *"Confirmed. They can now be paid by bank transfer — by someone other than you."* |

### 3.4 Raise the payout (as `oea.finance`)

**Period this run covers:** `4.4 rehearsal` → **Raise payout**.

| Check | Expect |
|---|---|
| 3.4a | *"Raised for approval — Ifeoma Duru."* |
| 3.4b | The landlord leaves **Held for landlords** and the payout waits for approval |

### 3.5 The outbound chain (OEA's ladder)

Each person goes to **Approvals** and opens the payout:

| Check | Who | Stage | Expect |
|---|---|---|---|
| 3.5a | `oea.auditapprover` | 1: Audit review and recommendation | approves |
| 3.5b | `oea.executive` | 2: Managing Partner approval | approves |
| 3.5c | `oea.approver` | 3: Payment approval | asked to **state the amount** being approved (0270). A wrong figure is refused; the right one approves |

### 3.6 The Payment Officer sends it (as `oea.finance`)

**Ledger → Payouts** → the approved payout → **Record a bank transfer**:
- **Date you made the transfer:** today.
- **Transfer reference:** `TEST-44-OUT`.
- **Your bank's confirmation:** attach the second test file.
- **Record the transfer.**

| Check | Expect |
|---|---|
| 3.6a | *"Recorded — ₦… to Ifeoma Duru."*, with the amount matching 3.1 |
| 3.6b | The payout leaves the queue as paid |

### 3.7 The landlord is told (as `oea.owner`)

| Check | Expect |
|---|---|
| 3.7a | The payment is visible to them: a notification in the bell, or the payout listed on their own pages. Note which. The email copy won't arrive on staging (§0) |
| 3.7b | The **Remittance advice** (from the notification) shows the amount, `TEST-44-OUT` and **The bank transfer, as recorded**, in OEA's name only |

### 3.8 Reconcile the payment out (as `oea.approver`)

As in §2, import one line: today's date, `TRF TO IFEOMA DURU - REMITTANCE TEST`,
`TEST-44-OUT`, **debit** = the amount from 3.6, external_id `TEST44OUT1`.

| Check | Expect |
|---|---|
| 3.8a | **Auto-match:** *"Matched 1 line(s)"* |

---

## 4. What would make this a FAIL

Any of these is a finding for 4.6, to be fixed before go/no-go:
- Money moving **before** stage 3 (1.2c, 1.4a, 1.8c).
- A desk **skipped**, or acting out of turn.
- Anything showing the **other** brand (1.1b, 3.2a, 3.7b).
- A spent link that still works, or that names someone (3.2c).
- The officer able to send without three approvals, or the person who checked
  the account able to record the transfer.
- An amount on any screen that doesn't agree with the ₦50,000 (net of fee where
  expected).

A variance in 2c on its own is **not** a FAIL. Staging's history is known to be
untidy.

## 5. Afterwards

Nothing to clean up. It's staging, and these rows are the evidence. Commit the
results file.

## 6. Results table

```
| Check | Result | What you saw |
|---|---|---|
| 1.1a | | |
| 1.1b | | |
| 1.2a | | |
| 1.2b | | |
| 1.2c | | |
| 1.3a | | |
| 1.3b | | |
| 1.3c | | |
| 1.4a | | |
| 1.5a | | |
| 1.6a | | |
| 1.6b | | |
| 1.6c | | |
| 1.7a | | |
| 1.7b | | |
| 1.8a | | |
| 1.8b | | |
| 1.8c | | |
| 2a | | |
| 2b | | |
| 2c | | variance: ₦ |
| 3.1a | | amount held: ₦ |
| 3.2a | | |
| 3.2b | | |
| 3.2c | | |
| 3.3a | | |
| 3.4a | | |
| 3.4b | | |
| 3.5a | | |
| 3.5b | | |
| 3.5c | | |
| 3.6a | | amount sent: ₦ |
| 3.6b | | |
| 3.7a | | |
| 3.7b | | |
| 3.8a | | |
```
