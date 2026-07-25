import Script from "next/script";
import { XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getBrandTheme } from "@/lib/brands";
import ApplyForm from "./ApplyForm";

// Public page — no session required. The org must have opted in; an unknown or
// closed org gets the same message, so this cannot be used to discover orgs.
export default async function ApplyPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  // A malformed id would make the RPC throw; treat it as "closed".
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId);

  const supabase = await createClient();
  const { data } = isUuid
    ? await supabase.rpc("vendor_application_org", { p_org_id: orgId })
    : { data: null };

  const org = (data as { org_name: string; delivery_brand: string }[] | null)?.[0] ?? null;
  const theme = getBrandTheme(org?.delivery_brand);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null;

  return (
    <main
      className="min-h-screen bg-background px-4 py-10"
      style={
        {
          "--brand": theme.primary,
          "--brand-fg": theme.primaryForeground,
        } as React.CSSProperties
      }
    >
      {siteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
        />
      )}

      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
          >
            {(theme.logoText ?? "OE").slice(0, 2)}
          </span>
          <span className="font-semibold">{org?.org_name ?? "OE Group"}</span>
        </div>

        {!org ? (
          <div className="space-y-3 rounded-lg border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="size-5" />
              <h1 className="text-lg font-semibold">Applications aren&apos;t open</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              This link isn&apos;t accepting vendor applications at the moment.
              Please check with your contact for an up-to-date link.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Vendor application
              </h1>
              <p className="text-sm text-muted-foreground">
                Register your business with{" "}
                <span className="font-medium text-foreground">{org.org_name}</span>.
                Only your business name, contact name and email are required —
                everything else helps us review you faster.
              </p>
            </div>

            <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
              <ApplyForm orgId={orgId} turnstileSiteKey={siteKey} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
