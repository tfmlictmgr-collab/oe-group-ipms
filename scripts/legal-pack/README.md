# Generating the legal review pack

Produces the `.docx` files in `docs/legal/` that go to external counsel.

    npm i --no-save docx
    node scripts/legal-pack/make-compliance-docx.cjs   # the 7 markdown documents
    node scripts/legal-pack/make-policy-docx.cjs       # Terms and Refund Policy

⚠️ **`docx` is deliberately NOT in `package.json`.** It is needed only to
produce this pack, and adding it would change `package-lock.json`, and with it
`npm ci`, the `npm audit` snapshot and the Stage 0 gates — during a cutover
window, for a document generator. Install it with `--no-save` when you need it.

## Two generators, and one of them is weaker

`make-compliance-docx.cjs` reads the markdown in `docs/` directly, so its output
cannot drift from the source: change the markdown, re-run, done.

`make-policy-docx.cjs` does **not** read `app/legal/*.tsx`. Those are React
components — the text is interleaved with JSX, conditionals and entities — so
the wording was transcribed once into `policy-content.json` and verified against
the pages clause by clause.

⚠️ **That transcription can go stale silently.** If anybody edits
`app/legal/terms/page.tsx` or `app/legal/refunds/page.tsx`, this JSON does not
know. Re-read both pages against it before sending anything to counsel, or the
lawyer reviews wording the site no longer serves. Making the pages the single
source (extracting at build time, or moving the prose into data the page
renders) is the durable fix and is not done.
