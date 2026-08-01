# Brand hostnames — setup

Each organisation can answer on its own hostname. `portal.tfmlconsultant.com`
resolves TFML, `portal.oraegbunike.com` resolves OEA, and neither host will
serve the other's front door.

## You do not need to register anything new

TFML and OEA already own `tfmlconsultant.com` and `oraegbunike.com`. **Use a
subdomain of each, not the apex.**

| Use | Don't use |
|---|---|
| `portal.tfmlconsultant.com` | `tfmlconsultant.com` |
| `portal.oraegbunike.com` | `oraegbunike.com` |

The apex domains serve the existing marketing websites. Pointing them at the
portal would take those sites down. A subdomain leaves them untouched and is
what clients expect from a login address anyway — `portal.` or `app.` reads as
"the system", where the bare domain reads as "the company".

Pick one prefix and use it for both brands, so the pattern is guessable.

## The three steps, in order

**1 · DNS** — at whoever hosts each domain's DNS (likely the registrar):

```
portal.tfmlconsultant.com.   CNAME   cname.vercel-dns.com.
portal.oraegbunike.com.      CNAME   cname.vercel-dns.com.
```

A **CNAME**, not an A record — the deployment's address changes and a CNAME
follows it. Propagation is usually minutes; allow up to an hour.

**2 · Vercel** — add each hostname to the project (Settings → Domains). Vercel
issues the TLS certificate automatically once DNS resolves. A domain that is not
added here will not be served no matter what DNS says.

**3 · In the app** — sign in as the platform administrator at `/login`, and on
the launcher click the hostname line under an organisation to bind it. Only an
operator can do this, and every bind is written to `operator_actions` with a
reason.

The order matters: bind in the app **after** Vercel is serving the host,
otherwise the first visitor gets a certificate error rather than a sign-in page.

## What a hostname does and does not do

**It paints a front door.** Visiting `portal.tfmlconsultant.com` renders TFML's
sign-in — their colours, logo and wording — and the root redirects there, so a
TFML employee never sees a generic OE Group screen.

**It grants nothing.** The Host header comes from the client. A proxy validates
it in production, but the application does not depend on that: the caller's
organisation comes from the verified JWT and row-level security decides every
row. Someone forging a Host header sees another brand's *colours* on a login
form and reaches none of their data.

That distinction is why binding a domain is an operator act and is not in the
column allowlist a brand administrator can write. A tenant able to set its own
`custom_domain` could claim a hostname belonging to another tenant and have the
platform paint their brand on it.

## Verifying

```bash
node scripts/verify-custom-domains.mjs
```

20 checks: a host resolves one row and cannot be made to list, an unknown host
resolves nothing, wildcards and quotes match literally, case and port normalise,
a tenant admin cannot bind by RPC or by patching the column, two organisations
cannot share a host, a URL or path is refused rather than stored and never
matched, every bind is audited, and a retired organisation stops answering.

## If a host stops resolving

- **Certificate error** — the domain is not added in Vercel, or DNS has not
  propagated. Check `nslookup portal.tfmlconsultant.com`.
- **Generic OE Group login instead of the brand** — the hostname is not bound in
  the app, or is bound with a scheme/port/path. `set_org_domain` refuses those,
  so it is most likely simply unbound.
- **404 on `/o/<slug>`** — expected when the slug does not belong to the org
  bound to that host. That is the isolation working.
- **Localhost and `*.vercel.app`** never resolve to a brand, deliberately —
  development and preview stay on the generic door.
