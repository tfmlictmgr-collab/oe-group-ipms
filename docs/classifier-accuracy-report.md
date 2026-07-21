# Classifier Accuracy Report

**Generated:** 2026-07-21T02:57:21.787Z
**Sample:** `docs/sample-requests.json` (24 synthetic, hand-labelled requests)
**Classifier:** `lib/triage.ts` → `classifyMessage` (Claude `claude-sonnet-4-6`, live intake path)

## Agreement rate

| Metric | Result |
|---|---|
| Category agreement | 24/24 (100.0%) |
| Priority agreement | 15/24 (62.5%) |
| Priority within one step | 24/24 (100.0%) |
| Both category + priority correct | 15/24 (62.5%) |

### Per-category (category agreement)

| Category | Agreement |
|---|---|
| maintenance | 10/10 |
| billing | 5/5 |
| vendor | 3/3 |
| complaint | 3/3 |
| general | 3/3 |

## Disagreements

- **S08** — priority `normal`→`high` (one step)  
  _"Abeg the cleaners never come clean my corridor for two weeks now"_
- **S09** — priority `normal`→`low` (one step)  
  _"I want to know my service charge balance for this year"_
- **S11** — priority `high`→`normal` (one step)  
  _"I paid my service charge last week but it is still showing as unpaid on my statement"_
- **S13** — priority `high`→`normal` (one step)  
  _"I am disputing the arrears on my account, I already cleared it in January"_
- **S14** — priority `normal`→`low` (one step)  
  _"This is Sparkle Cleaning. We have completed the deep clean for Block A, invoice attached ref INV-2026-0088"_
- **S15** — priority `normal`→`low` (one step)  
  _"SecureGuard here — night shift completed, submitting our monthly invoice for payment"_
- **S16** — priority `normal`→`low` (one step)  
  _"CoolAir HVAC: the servicing job for Ikoyi Heights is done, please process our payment"_
- **S19** — priority `normal`→`high` (one step)  
  _"The noise from the construction next door is disturbing every night, nobody is doing anything"_
- **S22** — priority `normal`→`low` (one step)  
  _"How do I register my new tenant on the portal?"_

## Notes

- Priority is inherently more subjective than category; "within one step" is
  reported because a low↔normal or high↔critical difference is often a defensible
  judgement call rather than an error.
- Sample is **synthetic** (no real client data at POC time). Re-run against a real
  anonymised sample when available; the harness is unchanged.
