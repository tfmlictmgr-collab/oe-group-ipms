import { notFound } from "next/navigation";
import { Building2, User } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase/admin";
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

export default async function ApplyPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ type?: string; resume?: string; property?: string }>;
}) {
  const { org } = await params;
  const { type, resume, property } = await searchParams;

  if (!/^[0-9a-f-]{36}$/i.test(org)) notFound();

  const { data: organisation } = await supabaseAdmin
    .from("orgs")
    .select("id, name, portal_name, logo_url, theme_primary, tenant_applications_open, delivery_brand")
    .eq("id", org)
    .maybeSingle();

  // A closed window, a missing module and a wrong id all answer the same way.
  // Distinguishing them would let someone map which orgs exist.
  if (!organisation) notFound();

  const { data: hasModule } = await supabaseAdmin.rpc("org_has_module", {
    p_org_id: org,
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
    { p_org_id: org }
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



  if (!organisation.tenant_applications_open || !hasModule || accepting.length === 0) {
    return (
      <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">Applications are closed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {brandName} is not accepting tenancy applications at the moment. If
            you were given this link directly, please go back to whoever sent it.
          </p>
        </div>
      </Shell>
    );
  }

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
    if (!draft || draft.org_id !== org) {
      return (
        <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <h1 className="text-lg font-semibold">This link no longer works</h1>
            <p className="mt-2 text-sm text-muted-foreground">
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
        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Where would you like to live?</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              These are the properties taking applications at the moment.
            </p>
          </div>
          {accepting.map((p) => (
            <ChoiceCard
              key={p.id}
              href={`/tenancy/${org}?property=${p.id}`}
              icon={<Building2 className="size-5" />}
              title={p.name}
              body={p.address ?? "Tap to apply for a tenancy here."}
            />
          ))}
        </div>
      </Shell>
    );
  }

  return (
    <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
      {chosen ? (
        <StartApplication
          orgId={org}
          propertyId={effective.id}
          propertyName={effective.name}
          type={chosen}
          brandName={brandName}
        />
      ) : (
        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Apply for a tenancy</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {effective.name} — two forms, one for a person and one for a
              business. Pick whichever describes who will hold the tenancy.
            </p>
          </div>

          <ChoiceCard
            href={`/tenancy/${org}?property=${effective.id}&type=individual`}
            icon={<User className="size-5" />}
            title="I'm applying as an individual"
            body="A home for you or your family. You'll need an ID, a passport photograph, and a guarantor."
          />
          <ChoiceCard
            href={`/tenancy/${org}?property=${effective.id}&type=corporate`}
            icon={<Building2 className="size-5" />}
            title="I'm applying as a business"
            body="A shop, office or commercial space. You'll need your CAC certificate, TIN, and two trade references."
          />

          <p className="pt-2 text-center text-xs text-muted-foreground">
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
      className="min-h-dvh bg-background px-4 py-8"
      style={{ ["--brand" as string]: brand, ["--brand-fg" as string]: "#ffffff" }}
    >
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          {logo ? (
            // A per-org URL, so next/image's domain allow-list cannot cover it.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-9 w-auto max-w-[140px] object-contain" />
          ) : (
            <span
              className="flex size-9 items-center justify-center rounded-lg text-sm font-bold"
              style={{ background: brand, color: "#fff" }}
            >
              {brandName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{brandName}</span>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
          {children}
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Your information is used to assess this application only, is read by a
          person rather than a machine, and is deleted after 90 days if the
          application is unsuccessful.
        </p>
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
      className="flex items-start gap-3 rounded-lg border border-border p-4 transition-colors hover:border-[var(--brand)] hover:bg-accent"
    >
      <span className="mt-0.5 text-[var(--brand)]">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
      </span>
    </a>
  );
}
