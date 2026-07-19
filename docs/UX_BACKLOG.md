# UX / UI Production-Readiness Backlog

**Status:** deferred — captured during Week 2 (Day 11/12 boundary), to be scheduled
after the POC demo gate.

The current UI is **POC-grade**: functional, responsive, and demo-safe, but
deliberately utilitarian. It is *not* production-ready. This is the agreed list
of work required to get it there.

---

## 1. Navigation & layout
- **Mobile menu pattern** — replace the wrapping nav strip with a proper
  hamburger / slide-over drawer. Current wrap works but is not a production
  pattern once nav grows past ~7 items.
- Active-route highlighting in nav (currently no indication of where you are).
- Sticky header on scroll for long tables.
- Breadcrumbs on detail pages (currently a single "← Back" link).

## 2. Forms & inputs
- **Show/hide password toggle** on the login form.
- Inline field-level validation with messages (currently only browser-native
  `required` + a single server error banner).
- Disabled/pending states on every submit path (partially done).
- "Forgot password" / password reset flow (not implemented at all).
- Autofocus first field; proper `autocomplete` attributes.

## 3. Interactivity & feedback
- **Toast/notification system** for success + error (currently a redirect with
  no confirmation that anything happened).
- Loading skeletons for server components instead of blank flashes.
- Optimistic UI on status changes.
- Confirmation dialogs before irreversible/financial actions (approve payment,
  generate invoices, regenerate invoices).
- Empty-state illustrations + guidance (currently plain dashed boxes).

## 4. Data presentation
- Tables: sorting, pagination, and column visibility (audit log is capped at 200
  rows with no paging).
- Card/table responsive switch — render wide tables as stacked cards on mobile
  rather than horizontal scroll.
- Search + filtering on Requests, Vendors, Payments (only Audit has filters).
- Export to CSV/PDF (PDF generation is in the B3 stack via @react-pdf/renderer
  but not yet wired to any view).

## 5. Brand & visual design
- Full TFML / OEA brand theming pass — brand tokens exist in `lib/brands.ts`
  and drive the header, but typography, buttons, and charts are still neutral.
- Logo assets (currently a text "OE" badge placeholder).
- Consistent spacing/type scale; design tokens rather than ad-hoc Tailwind.
- Dark mode (Tailwind is configured for `class` dark mode; unused).

## 6. Accessibility (not yet assessed)
- Keyboard navigation and focus-visible states.
- ARIA labels on icon-only controls and status badges.
- Colour-contrast audit (badge colours not verified against WCAG AA).
- Screen-reader labelling for charts//data viz.

## 7. PWA / offline
- CLAUDE.md B3 specifies an offline-capable PWA (Nigerian connectivity context).
  **Not implemented** — no service worker, manifest, or offline caching yet.

---

## Notes
- None of the above blocks the POC demo; all of it blocks production rollout.
- Item 7 (PWA/offline) and item 4 (PDF export) are explicitly in the CLAUDE.md
  Phase-1 scope, so they are *scope*, not polish — they should be scheduled
  rather than treated as nice-to-have.
