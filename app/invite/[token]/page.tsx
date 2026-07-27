import Link from "next/link";
import { ShieldCheck, XCircle } from "lucide-react";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { previewInvitation } from "./actions";
import AcceptForm from "./AcceptForm";

// Public route — deliberately outside /dashboard, since the invitee has no
// account yet and middleware would bounce them to /login.

const isHex = (v: string | null | undefined) => !!v && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);

/** Two letters from the org name, for orgs that have not uploaded a logo. */
function initials(name: string | null | undefined): string {
  const words = (name ?? "").replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await previewInvitation(token);

  // The page wears the brand that sent the invitation, not a house default.
  // Showing "OE Group Portal" above "TFML has invited you" put two brands on the
  // first screen a new user ever sees, with the wrong one in the position of
  // trust — and OE Group is not client-facing at all (B1).
  //
  // Falls back to neutral wording rather than a specific brand when the token is
  // invalid: at that point we have no org, and guessing one would be worse than
  // saying nothing.
  const brandMark = invite?.logoText?.trim() || initials(invite?.orgName);
  const portalName = invite?.portalName?.trim() || invite?.orgName || "Portal";
  const primary = isHex(invite?.primary) ? invite!.primary! : null;

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background px-4 py-10"
      style={primary ? ({ "--brand": primary } as React.CSSProperties) : undefined}
    >
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          {invite?.logoUrl ? (
            /* The logo is an org-uploaded URL on Supabase Storage; next/image
               would need every org's host allow-listed at build time. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={invite.logoUrl}
              alt={portalName}
              className="h-10 max-w-[9rem] object-contain"
            />
          ) : (
            <span
              className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
              style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
            >
              {brandMark}
            </span>
          )}
          <span className="font-semibold">{portalName}</span>
        </div>

        {!invite ? (
          // One message for every failure mode, so the page can't be used to
          // probe which tokens exist.
          <div className="space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="size-5" />
              <h1 className="text-lg font-semibold">This invitation isn&apos;t valid</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              The link may have expired, already been used, or been revoked.
              Invitations last 14 days. Ask whoever invited you to send a new one.
            </p>
            <Button asChild variant="outline">
              <Link href="/login">Go to sign in</Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm">
            <div className="space-y-2">
              <h1 className="text-xl font-semibold tracking-tight">
                You&apos;ve been invited
              </h1>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{invite.orgName}</span> has
                invited you to join as{" "}
                <span className="font-medium text-foreground">{roleLabel(invite.role)}</span>.
              </p>
            </div>

            <AcceptForm
              token={token}
              email={invite.email}
              suggestedName={invite.fullName}
            />

            <p className="flex items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 flex-shrink-0" />
              Your access level was set by whoever invited you and can&apos;t be
              changed during sign-up. This link works once and expires in 14 days.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
