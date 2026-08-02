import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Building2, User, ShieldCheck, ChevronRight } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolvePublicOrg } from "@/lib/org-public";
import { hashToken } from "@/lib/application-resume";
import StartApplication from "./StartApplication";
import ApplicationForm from "./ApplicationForm";

// The public application page. Unauthenticated by design — a prospective tenant
// has no account and will not make one to enquire.
//
// Read with the service role because there is no session to read with, and
// deliberately only the branding: what is exposed here is what a stranger who
// guesses an org id can see, so it is the org's public face and nothing else.

// Never cached. This page's content depends on live organisation state — the
// lettings module and the open/closed window — and a cached render meant an org
// could open applications and have the public link keep saying "closed" until
// the next deploy. The person who would notice is a prospect who quietly gives
// up, so this is a correctness question rather than a performance one.
export const dynamic = "force-dynamic";

/**
 * This page's own metadata, carrying the ORG's name and nothing else.
 *
 * Without it the page inherited the root description — which named both brands
 * until it was fixed. This is the most-shared public link in the product: a
 * letting agent pastes it into WhatsApp, and the preview card is the first
 * thing a prospective tenant sees. It should say whose it is.
 *
 * `noindex` because a tenancy application form has no business in a search
 * index: the link is given to people, and an indexed one is an open door.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ org: string }>;
}): Promise<Metadata> {
  const { org } = await params;
  const organisation = await resolvePublicOrg(org);
  if (!organisation) return { title: "Not found", robots: { index: false, follow: false } };

  const name = organisation.portal_name || organisation.name;
  const description = `Apply for a tenancy with ${name}. Every application is read by a person.`;

  return {
    title: `Apply for a tenancy — ${name}`,
    description,
    robots: { index: false, follow: false },
    openGraph: { title: `Apply for a tenancy — ${name}`, description, siteName: name },
  };
}

export default async function ApplyPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ type?: string; resume?: string; property?: string }>;
}) {
  const { org } = await params;
  const { type, resume, property } = await searchParams;

  // Slug or id. New links carry the slug — `/tenancy/oea` is something a
  // letting agent can say down a phone — while every id already sent out keeps
  // working, because those links are in inboxes and on printed sheets and
  // breaking them to tidy a URL would strand applicants who did nothing wrong.
  const organisation = await resolvePublicOrg(org);

  // ⚠️ An unknown handle 404s; a real org with intake closed renders the closed
  // card. Those are NOT the same answer, and the comment here used to claim they
  // were — so a reader would have believed a property this page has never had.
  //
  // The difference reveals that an organisation exists, which is the same
  // exposure `/o/<slug>` already carries and which decision 12 accepted on the
  // same reasoning: a link you were *given* resolves, and neither route can be
  // made to list. Enumeration is what B1 forbids, and no handle here can be
  // turned into a directory. Worth re-examining if slugs ever become guessable
  // in bulk — a wordlist against short brand slugs is the realistic attack.
  if (!organisation) notFound();

  const orgId = organisation.id;
  // What subsequent links on this page should carry: whatever the visitor
  // arrived on stays consistent, so a shared URL keeps its readable form.
  const handle = organisation.slug || orgId;

  const { data: hasModule } = await supabaseAdmin.rpc("org_has_module", {
    p_org_id: orgId,
    p_module: "lettings",
  });

  const brandName = organisation.portal_name || organisation.name;
  const brand = /^#[0-9a-fA-F]{6}$/.test(organisation.theme_primary ?? "")
    ? organisation.theme_primary!
    : "#003366";

  // Which properties are taking applications right now. The org flag is the
  // master switch; each property then decides for itself (0076).
  const { data: openProperties, error: acceptingError } = await supabaseAdmin.rpc(
    "properties_accepting_applications",
    { p_org_id: orgId }
  );

  // A failed call here used to render "Applications are closed" — indistinguishable
  // from a deliberate closure, and silent. That is the same shape as the RLS read
  // that returned zero rows without erroring and blocked every submission: the
  // page said something confident and wrong. Log it loudly; the applicant still
  // sees the closed card, because there is nothing better to show them, but an
  // operator can find out why.
  if (acceptingError) {
    console.error(
      "properties_accepting_applications failed for org", org, "-", acceptingError.message
    );
  }
  const accepting = (openProperties ?? []) as { id: string; name: string; address: string | null }[];



  // Returning through the emailed link.
  //
  // Matched on the HASH of the token, so the stored value is useless to anyone
  // reading the database. An expired, submitted or unknown token all answer the
  // same way — otherwise this page would tell a stranger which tokens exist.
  if (resume) {
    const { data: draft } = await supabaseAdmin
      .rpc("resume_application", { p_token_hash: hashToken(resume) })
      .maybeSingle<{
        id: string;
        org_id: string;
        type: "individual" | "corporate";
        form: Record<string, unknown> | null;
      }>();

    // `org_id` is re-checked against the URL: a token is for one application in
    // one organisation, and must not open a draft through another org's page.
    //
    // ⚠️ Compared to the RESOLVED id, not the handle from the URL. When this
    // page only accepted uuids the two were the same string; now that `/tenancy/oea`
    // is valid, comparing against the handle would fail every slug-based resume
    // link — telling an applicant their valid link "no longer works".
    if (!draft || draft.org_id !== orgId) {
      return (
        <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
          <div className="py-4 text-center">
            <h1 className="display-sm text-balance">This link no longer works</h1>
            <p className="mx-auto mt-3 max-w-sm text-pretty text-muted-foreground">
              A saved application can be reopened for {30} days, and the link stops
              working once the application has been submitted. Start again, or ask
              the letting team if you think this is wrong.
            </p>
          </div>
        </Shell>
      );
    }

    return (
      <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
        <ApplicationForm
          applicationId={draft.id}
          resumeToken={resume}
          type={draft.type}
          orgName={brandName}
          initialValues={(draft.form ?? {}) as Record<string, unknown>}
          supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL!}
          anonKey={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}
        />
      </Shell>
    );
  }

  // The intake gate comes AFTER the resume branch, and that order is the point.
  //
  // Closing intake stops NEW applications; it must not strand one already in
  // progress. Until this was reordered, a valid 30-day link returned the "closed"
  // card the moment the org — or its last accepting property — stopped taking
  // applicants, which contradicted the email we had just sent the applicant.
  //
  // Someone half way through a form, whose property has since filled up, still
  // gets to finish. That is what the 30 days promised.
  if (!organisation.tenant_applications_open || !hasModule || accepting.length === 0) {
    return (
      <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
        <div className="py-4 text-center">
          <h1 className="display-sm text-balance">Applications are closed</h1>
          <p className="mx-auto mt-3 max-w-sm text-pretty text-muted-foreground">
            {brandName} is not accepting tenancy applications at the moment. If
            you were given this link directly, please go back to whoever sent it.
          </p>
        </div>
      </Shell>
    );
  }

  const chosen = type === "corporate" || type === "individual" ? type : null;

  // Which property. Validated against the list that is actually accepting, so a
  // guessed or stale id cannot start an application against a closed property —
  // and the id in the URL is never trusted on its own.
  const selected = property ? accepting.find((p) => p.id === property) ?? null : null;

  // One open property is not a choice worth making someone make.
  const effective = selected ?? (accepting.length === 1 ? accepting[0] : null);

  if (!effective) {
    return (
      <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
        <div className="space-y-5">
          <div>
            <p className="eyebrow text-[var(--brand)]">{brandName}</p>
            <h1 className="display-md mt-2 text-balance">Where would you like to live?</h1>
            <p className="mt-2 text-muted-foreground">
              These are the properties taking applications at the moment.
            </p>
          </div>
          <div className="stagger space-y-3">
            {accepting.map((p) => (
              <ChoiceCard
                key={p.id}
                href={`/tenancy/${handle}?property=${p.id}`}
                icon={<Building2 className="size-5" />}
                title={p.name}
                body={p.address ?? "Tap to apply for a tenancy here."}
              />
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
      {chosen ? (
        <StartApplication
          orgId={orgId}
          propertyId={effective.id}
          propertyName={effective.name}
          type={chosen}
          brandName={brandName}
        />
      ) : (
        <div className="space-y-5">
          <div>
            <p className="eyebrow text-[var(--brand)]">{effective.name}</p>
            <h1 className="display-md mt-2 text-balance">Apply for a tenancy</h1>
            <p className="mt-2 text-pretty text-muted-foreground">
              Two forms — one for a person, one for a business. Pick whichever
              describes who will hold the tenancy.
            </p>
          </div>

          <div className="stagger space-y-3">
          <ChoiceCard
            href={`/tenancy/${handle}?property=${effective.id}&type=individual`}
            icon={<User className="size-5" />}
            title="I'm applying as an individual"
            body="A home for you or your family. You'll need an ID, a passport photograph, and a guarantor."
          />
          <ChoiceCard
            href={`/tenancy/${handle}?property=${effective.id}&type=corporate`}
            icon={<Building2 className="size-5" />}
            title="I'm applying as a business"
            body="A shop, office or commercial space. You'll need your CAC certificate, TIN, and two trade references."
          />
          </div>

          <p className="pt-1 text-center text-sm text-muted-foreground">
            You can save and come back — the form does not have to be finished in
            one sitting.
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({
  brandName, brand, logo, children,
}: {
  brandName: string;
  brand: string;
  logo: string | null;
  children: React.ReactNode;
}) {
  return (
    <main
      className="bg-brand-wash min-h-dvh bg-background px-4 py-8 sm:py-12"
      style={{ ["--brand" as string]: brand, ["--brand-fg" as string]: "#ffffff" }}
    >
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="animate-fade flex items-center gap-3">
          {logo ? (
            // A per-org URL, so next/image's domain allow-list cannot cover it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-9 w-auto max-w-[140px] object-contain" />
          ) : (
            <span
              className="flex size-9 items-center justify-center rounded-lg text-sm font-bold shadow-sm"
              style={{ background: brand, color: "#fff" }}
            >
              {brandName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="font-semibold tracking-tight">{brandName}</span>
        </header>

        <div className="animate-rise rounded-2xl border border-border/80 bg-card p-5 shadow-[var(--shadow-md)] sm:p-7">
          {children}
        </div>

        {/* The reassurances a person actually wants before handing over an ID.
            Stated as three separate promises rather than one paragraph — a wall
            of small grey text is not read, and each of these is load-bearing. */}
        <ul className="stagger grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          {[
            "Read by a person, never scored by a machine",
            "Used only to assess this application",
            "Deleted after 90 days if unsuccessful",
          ].map((t) => (
            <li key={t} className="flex items-start gap-1.5">
              <ShieldCheck className="mt-px size-3.5 flex-shrink-0 text-[var(--brand)]" />
              <span className="text-pretty">{t}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

function ChoiceCard({
  href, icon, title, body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <a
      href={href}
      className="group flex items-start gap-3.5 rounded-xl border border-border p-4 transition-all hover:-translate-y-px hover:border-[var(--brand)] hover:shadow-[var(--shadow-md)] sm:p-5"
    >
      <span
        className="flex size-10 flex-shrink-0 items-center justify-center rounded-lg text-[var(--brand)] transition-colors"
        style={{ background: "color-mix(in srgb, var(--brand) 10%, transparent)" }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{body}</span>
      </span>
      <ChevronRight className="mt-2.5 size-4 flex-shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--brand)]" />
    </a>
  );
}
