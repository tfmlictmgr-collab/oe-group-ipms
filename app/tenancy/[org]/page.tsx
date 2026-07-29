import { notFound } from "next/navigation";
import { Building2, User } from "lucide-react";
import { supabaseAdmin } from "@/lib/supabase/admin";
import StartApplication from "./StartApplication";

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
  searchParams: Promise<{ type?: string }>;
}) {
  const { org } = await params;
  const { type } = await searchParams;

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

  if (!organisation.tenant_applications_open || !hasModule) {
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

  const chosen = type === "corporate" || type === "individual" ? type : null;

  return (
    <Shell brandName={brandName} brand={brand} logo={organisation.logo_url}>
      {chosen ? (
        <StartApplication orgId={org} type={chosen} brandName={brandName} />
      ) : (
        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Apply for a tenancy</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Two forms — one for a person, one for a business. Pick whichever
              describes who will hold the tenancy.
            </p>
          </div>

          <ChoiceCard
            href={`/tenancy/${org}?type=individual`}
            icon={<User className="size-5" />}
            title="I'm applying as an individual"
            body="A home for you or your family. You'll need an ID, a passport photograph, and a guarantor."
          />
          <ChoiceCard
            href={`/tenancy/${org}?type=corporate`}
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
