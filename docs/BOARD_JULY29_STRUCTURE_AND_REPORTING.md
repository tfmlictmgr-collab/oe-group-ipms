# Board recommendations, 29 July 2026 — structure, reporting, occupancy, AI verification

**Status:** design for approval. One item (§5) requires the board to amend a locked
decision before it can be built. Everything else is buildable as specified.

Grounded in the code as it stands on `phase-1`, not on the brief: `properties` and
`units` exist and carry soft-delete plus composite `(property_id, org_id)` foreign
keys (`0056`, `0057`); `assets` hang off `property_id` with a nullable `unit_id`
(`0016`); `current_user_property_ids()` (`0008`) is referenced **42 times across 13
migrations** and is the single scoping resolver in the system; the BI views (`0061`)
aggregate by `org_id` and nothing else.

---

## 1. REGION → PROJECT → LOCATION → SITE → PROPERTY → UNIT → ASSET

### Recommendation: one hierarchy table, not five

Five nested tables would mean five joins on every scoped read, five RLS policies,
and — the real cost — a rewrite of the 42 places that scope on a property id.

```sql
create type hierarchy_level as enum ('region', 'project', 'location', 'site');

create table org_nodes (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  parent_id  uuid,
  level      hierarchy_level not null,
  name       text not null,
  code       text,                    -- the client's own code, if they use one
  path       text not null,           -- '/<region_id>/<project_id>/<location_id>/<site_id>'
  deleted_at timestamptz,
  -- Cross-org parenting must be structurally impossible, not merely disallowed
  -- by policy. A POC org placed a unit on TFML's property earlier in this build
  -- because the FK named only the parent id; the composite key is what fixed it.
  foreign key (parent_id, org_id) references org_nodes (id, org_id)
);

alter table properties add column site_node_id uuid,
  add foreign key (site_node_id, org_id) references org_nodes (id, org_id);
```

`path` is maintained by a trigger and indexed with `text_pattern_ops`, so
"everything in the North region" is one indexed prefix match rather than a
recursive CTE per query.

**The property stays the security anchor.** Every existing policy, the asset
register, service-charge budgets, tickets, tenant applications and the attaché
assignment keep working untouched. The hierarchy is a *dimension over* properties,
not a replacement for them.

### Scoping: extend the one resolver, never add a second

`property_stakeholders` gains a nullable `node_id`, so an FM can be attached to a
region or a project and have every property beneath it resolve automatically —
including properties added later.

```sql
create or replace function current_user_property_ids() ... as $$
  select property_id from property_stakeholders
   where user_id = auth.uid() and property_id is not null
  union
  select p.id from properties p
    join org_nodes n  on n.id = p.site_node_id
    join property_stakeholders s on s.user_id = auth.uid() and s.node_id is not null
    join org_nodes sn on sn.id = s.node_id
   where n.path like sn.path || '%'
     and p.org_id = current_user_org_id()
$$;
```

This is deliberate: a second scoping mechanism alongside the first is how the
`tickets.triage_unassigned` grant ended up contradicting the B7 baseline, and how
the ledger account resolver ended up applied in half the places that needed it.
**One resolver, extended.**

Performance: the function is already called inside scalar subqueries per `0052`,
so it evaluates once per statement rather than once per row. With B5's 100+
properties that matters.

### Migration safety

`site_node_id` starts nullable. Existing properties keep working while the tree is
populated; a property with no site is simply unfiled and still fully operable.
Requiring it comes as a separate step once the register is complete — not in the
same migration.

### Assets: make "shared" a stated fact

`assets.unit_id` is nullable today with the comment *"optional: building-wide plant
has none"*. That encodes "shared" as an **absence**, and absence is ambiguous with
"not filled in yet".

This is not a theoretical objection. Twice in the last two days a nullable foreign
key used as a meaning produced a live defect: WhatsApp requests invisible to every
property-scoped role, and tenant applications invisible to a Property Manager —
both because NULL never matches an `IN` list. **NULL means "unknown", never
"shared".**

```sql
create type asset_scope as enum ('unit', 'property', 'site');

alter table assets add column scope asset_scope not null default 'unit',
  add column site_node_id uuid,          -- plant serving a whole site
  add constraint assets_scope_shape check (
        (scope = 'unit'     and unit_id is not null)
     or (scope = 'property' and unit_id is null)
     or (scope = 'site'     and unit_id is null and site_node_id is not null)
  );
```

Backfill: every existing asset with a `unit_id` becomes `'unit'`; every one without
becomes `'property'`. That preserves current meaning exactly, then makes it
explicit.

**Consequence to plan for:** a shared asset's maintenance cost has to apportion
across the units that benefit, which lands in the service-charge apportionment
engine (Step 6). That is a real piece of finance logic, not a display change.

### Bulk upload

The existing asset and unit import templates gain `region / project / location /
site` columns, resolved by name-or-code within the org and rejected with a row
number when a name is ambiguous — the same validation-preview pattern the asset
import already uses. Nodes are **not** created implicitly by an import: a typo
would otherwise silently produce a new region.

---

## 2. Reports filtered by date, place and time

The board is right that this is not currently wired in. The `0061` views group by
`org_id` alone — there is no date dimension and no place dimension.

### Design

- **Parameterised report functions, `SECURITY INVOKER`.** RLS then applies to the
  caller, so a report can never show more than that person's dashboard. This is
  the one place where the definer-view pattern used elsewhere would be actively
  dangerous, because reports are the natural route for bulk extraction.
- **Aggregate in the database.** Never fetch rows to count them — that is the
  PostgREST 1000-row cap lesson, and a report is exactly where it bites hardest.
- **Bucket in `Africa/Lagos`, not UTC.** Nigeria is UTC+1 with no DST, so a report
  labelled "29 July" that buckets on UTC silently starts at 01:00 WAT and drops
  the first hour of the Nigerian day. For a collections or remittance report that
  is a reconciliation defect, not a cosmetic one:
  `date_trunc('day', created_at at time zone 'Africa/Lagos')`.
- **Dimensions:** date range, hierarchy node (prefix match), property, unit,
  category, urgency, status, vendor, channel, and role-appropriate financial cuts.
- **Saved report definitions per org**, so "monthly owner report" is a stored
  filter rather than something rebuilt by hand each month.
- **Every export is an audit event** (Module 5). Exporting a resident or applicant
  list is a data-protection event under NDPA, and the audit trail is what makes it
  defensible.
- Export via `@react-pdf/renderer` (already in the stack) and CSV.

---

## 3. Unit occupancy and the property

**Already tied.** `units.property_id` is `not null`, the composite
`(property_id, org_id)` FK from `0057` prevents a unit landing on another org's
property, and the occupancy page joins the property name and filters to properties
the user may write to.

What is missing is **presentation**: it lists units flat across properties. Group
it by property, and once §1 lands, by site → project → region. That is a UI change
with no schema consequence.

---

## 4. Opening and closing tenancy applications by vacancy

Today `orgs.tenant_applications_open` is a single org-wide boolean — all of OEA's
properties open, or none.

### Recommendation: per-property, three states, not a derived boolean

| State | Meaning |
|---|---|
| `auto` *(default)* | Open **iff** the property has at least one vacant, non-retired unit |
| `open` | Forced open — a waiting list on a fully occupied property |
| `closed` | Forced closed — refurbishment, legal dispute, a property not taking applicants |

Pure automation is the wrong answer even though it is what was asked for. A
landlord legitimately wants a waiting list on a full building, and legitimately
wants a property closed while its units sit empty. Deriving the state with **no
override** removes a judgement that belongs to a person; deriving it with an
override that is **recorded and audited** gives the board the automation it wants
without taking away the decision.

The org-level flag stays as a **master switch**, AND-ed with the property state, so
a brand can stop all intake at once.

### This also closes a blocker I recorded against Day 8

Applications currently carry `property_id = null`, so a Property Manager can see
none of them — property-scoped review, the premise of Day 8, returns nothing.

If an applicant arrives through a **property's own link**, `property_id` is set at
creation and the scoping works. Note the distinction from the earlier advice in
`PHASE1_WORKPLAN.md`: which link someone used is a *fact about how they applied*
and is sound to scope PII access by; a free-text "unit preference" they typed is a
*self-asserted claim* and is not. The board's recommendation happens to resolve
this properly.

---

## 5. AI verification before human approval — needs a board decision

⚠️ **This conflicts with a locked decision.** `CLAUDE.md` locked decision 2 and
`0062_tenant_applications.sql` both state that tenant screening is human and
**never automated**, citing NDPA Art. 37. The migration says so in its header, the
consent statement shown to every applicant says their data "will not be used for
any automated decision", and the schema was shaped around it — special-category
data lives in a separate column precisely so no model ever sees it.

The board's intent is achievable and sensible. But the line has to be drawn in the
right place, and the locked wording has to change deliberately rather than by
implication.

### The distinction that matters

**Document verification** is evidence handling. **Screening** is judgement. AI may
do the first and must not do the second.

| AI may | AI must not |
|---|---|
| Extract fields from uploaded documents (OCR) | Emit approve / reject |
| Check a CAC number or TIN is well-formed and matches what was typed | Produce a score, rank or "recommendation" |
| Check the name on an ID matches the applicant | Infer suitability, reliability or character |
| Confirm a passport photograph is a photograph of a face | Touch religion or marital status — the reason they are in a separate column |
| Flag expired documents and an incomplete document set | Be the thing a reviewer rubber-stamps |
| Flag the same ID appearing on another application | Rank one applicant against another |

### Why "a human clicks approve" is not by itself sufficient

The legal test is not whether a human was present; it is whether the decision was
**solely** automated with significant effect. Refusing someone housing is
significant, and nominal human involvement does not cure it. So the human's part
has to be real, by construction:

- AI output is **findings tied to evidence** — each one naming the document and the
  field it came from, never a conclusion about the person.
- The reviewer must record **their own reason**. Accepting AI findings alone cannot
  submit the decision.
- Every finding is stored, auditable and **contestable** — NDPA gives the applicant
  a right to explanation and correction, which means the findings must be
  retrievable and attributable months later.
- A **bias audit** on the extraction, as A3 already requires for the triage
  classifier.
- Behind a **per-org B9 feature flag, off by default**, so it is switched on
  deliberately per brand.

### Two consequences the board should see

1. **Consent wording.** The current statement remains true under this design — no
   automated *decision* is made — but it should gain a sentence saying documents
   are checked automatically and decided by a person. Because consent statements
   are stored verbatim on each application, existing applicants keep the wording
   they actually saw. That was designed for exactly this situation.
2. **A new data processor.** Sending identity documents to Claude makes Anthropic a
   processor for special-category-adjacent data, which needs a DPA (A3 already
   requires one per processor) and argues for sending **extracted text rather than
   the document image** wherever the check allows, plus short-TTL signed URLs from
   the private bucket.

### Proposed amendment to locked decision 2

> Tenant applications use a two-tier admin-configurable **human** review. No
> automated system may decide, score, rank or recommend an outcome. Automated
> **document verification** — extraction, format and consistency checks,
> completeness and duplicate detection — is permitted as decision *support*, must
> record its findings against the evidence they came from, and cannot substitute
> for the reviewer's recorded reason.

---

## Recommended sequence

Ordered by dependency, not by size. Reports want the hierarchy; Day 8 wants the
per-property window.

| Step | Work | Why here |
|---|---|---|
| **A** (~½ day) | Per-property application window (§4) + applications carry `property_id` | Unblocks Day 8 and closes the recorded blocker |
| **B** (~2 days) | `org_nodes` hierarchy, scoping extension, asset `scope` enum, import templates, tree UI (§1) | Touches the security anchor — do it as its own step, before reporting |
| **C** (Day 8) | Two-tier **human** review and approval | The board-locked design, unchanged |
| **D** (Day 8.5) | AI document verification, flag off by default (§5) | Only after the amendment in §5 is approved |
| **E** (Day 10) | Report generation with date/place filters (§2) | Depends on B for the place dimension |

Each step ships with a verification suite proving the security claims, as the
property register, permission matrix and tenant intake already do.

## Decisions needed before building

1. **§5** — approve the amendment to locked decision 2, or keep screening
   fully human for Phase 1.
2. **§1** — must every property sit under all four levels, or may levels be
   skipped (a property directly under a region, with no project)? Fixed depth and
   flexible depth are different constraints, and retrofitting either onto the
   other is expensive.
3. **§4** — confirm that overriding a property's `auto` state is an
   administrator-only action.

---

## 6. Decentralised FM/PM administration, and MD / MP oversight

**Yes — and two of the three pieces already exist.** They have simply never met.

- `property_stakeholders` + `current_user_property_ids()` answers **where** someone
  may act (`0008`).
- The permission matrix answers **what** they may do (`0050`).
- Nothing joins them for *actions*. A capability is a bare yes/no with no place
  attached, and only **read** policies bound it by property.

### The gap, stated precisely

`units_insert` admits anyone holding `properties.write` or
`units.assign_occupant`, with **no property scoping** (`0059`). So a Facility
Manager can today create a unit under any property in the org, not merely their
own — even though B7's FM row reads "Assigned properties (RT)". Decentralisation
is impossible until write actions are bounded the way reads already are.

### One capability closes it

```sql
-- Granted to admin, finance_approver and executive. NOT to a scoped role.
'scope.org_wide'
```

Every place-bearing write policy then reads uniformly:

```sql
has_permission('units.assign_occupant')
and (
  (select has_permission('scope.org_wide'))
  or property_id in (select current_user_property_ids())
)
```

Decentralisation becomes a matter of **which node you are attached to**, with no
per-action machinery. A regional administrator is someone whose stakeholder row
points at a REGION and who therefore reaches every property beneath it — including
properties added later, because the resolver matches on the path prefix.

⚠️ This **tightens** current access: a Facility Manager holding `properties.write`
loses org-wide write and keeps it only on assigned properties. That is what B7 says
should always have been true, but it is a live behaviour change and will be
confirmed against the running database before it ships, not assumed.

### Two new roles

Capabilities are per **role**, which is the board-approved B7 shape. Granting
`people.invite` to `facility_manager` would grant it to *every* FM, so a
decentralised regional administrator needs to be a distinct role rather than a
differently-assigned FM.

| Role | Who | Scope |
|---|---|---|
| `regional_manager` | The FM/PM running a region | Node subtree. Limited admin: invite operational staff, manage properties/units/assets within their region |
| `executive` | **MD** of TFML, **Managing Partner** of OEA | Org-wide oversight, co-holding central administration |

`executive` is one enum value with a brand-aware label — "Managing Director" on
TFML, "Managing Partner" on OEA — exactly as the FM/PM labels already work.

### Privilege escalation is the risk to design against

A regional administrator who may invite people is a confused deputy waiting to
happen. Two hard rules, enforced in the database rather than the form:

1. **You may only invite a role strictly below your own.** A regional manager
   cannot mint an admin, an executive, or another regional manager.
2. **You may only invite into your own subtree.** The invitation carries a node,
   validated against the inviter's path prefix.

`admin invitation` stays non-delegable per locked decision 7 — a regional manager
invites *operational* staff only.

### What MD / MP co-holding costs

Payment approval is hardwired to `('finance_approver','admin')` inside
`enforce_payment_transition()` (`0060`) — deliberately, because it is the control
an auditor checks, and it is proven to block a direct-API bypass. Adding
`executive` there is a **change to a non-delegable control**, so it is done in the
trigger itself, never as a toggle, and the verification suite is extended to prove
the threshold still holds for the new role.

Recommended: `executive` co-holds approval and full visibility, but **remittance
execution stays with finance**. Oversight and disbursement in the same pair of
hands removes the separation of duties that makes the audit trail worth anything.
That is a governance recommendation for the board to accept or overrule.

### Sequence

The hierarchy has to exist before a role can be scoped to a node, so:

| Step | Work |
|---|---|
| **B1** | `org_nodes` hierarchy + path (§1) |
| **B2** | Node-scoped stakeholders + extended `current_user_property_ids()` |
| **B3** | `scope.org_wide`, write policies bounded, confirmed against live data |
| **B4** | `regional_manager` and `executive` roles, invitation escalation rules, `executive` added to the approval trigger |

---

# Amendments minuted 3 August 2026

Two decisions changed after this paper was approved. Both are recorded here
because the paper above is what the board actually read, and a design document
that quietly matches the present tells nobody why anything moved.

## A1 — The hierarchy order: REGION → **LOCATION → PROJECT** → SITE

§1 above specifies REGION → PROJECT → LOCATION → SITE. **That order is
amended:** LOCATION now sits above PROJECT.

**Why.** The paper's own description of the structure is geographic — regions
follow Nigeria's geopolitical mapping, and the places named beneath them are
cities. Under the minuted order, "Kano" could not be recorded until a *project*
had been invented to contain it, because PROJECT sat between REGION and
LOCATION. A project happens **in** a place; a place does not happen in a
project. "Kano Housing Scheme" is a project in Kano, and there is no sense in
which Kano is inside a scheme.

The practical cost was a fiction in every regional report: a placeholder project
created solely so a city could exist beneath it.

**What it did not change.** `properties.site_node_id` still points at a SITE,
the path is still materialised, and `current_user_property_ids()` was untouched
— the resolver walks paths and never names a level, which is why reordering was
contained rather than sweeping. Existing nodes were re-levelled, never deleted,
because a node's id appears in the path of everything beneath it.

Nigeria's cities are seeded as **locations** under the three regions, for every
live organisation: Abuja, Kano, Sokoto, Kaduna, Jos, Maiduguri, Ilorin, Katsina
· Lagos, Ibadan, Benin City, Abeokuta, Akure, Osogbo, Warri · Port Harcourt,
Enugu, Owerri, Aba, Onitsha, Awka, Calabar, Uyo, Yenagoa, Umuahia.

*(Implemented in migration `0087`; the enum's own error message was corrected to
state the amended order in `0096`.)*

## A2 — Rent cadence and notice lead times

Not covered by this paper, and now settled: rent is billed **annually in
advance**, and renewal notices go out at **90, 60 and 30 days** before a tenancy
ends.

**Why annual in advance.** It is the Nigerian norm — one or two years up front
is ordinary and a monthly cycle is the exception. Most off-the-shelf property
systems assume monthly, and adopting that assumption would have modelled this
market wrongly at the root rather than at the edges.

**Both are per-organisation configuration**, not constants
(`orgs.rent_demand_lead_days`, `orgs.renewal_notice_days`, Settings → Lettings).
A commercial portfolio legitimately wants longer notice than a residential one,
and the moment a number like this becomes a constant is the moment the second
client cannot have it their way.

A notice fires once per (lease, threshold): the **record** decides, never the
schedule, so a retrying job cannot tell a tenant the same thing three times.
Rent demands are raised on the same principle — the unique constraint on
(lease, period) means a repeated run cannot bill a year twice.

*(Locked decision 15; implemented in `0093` and `0098`.)*
