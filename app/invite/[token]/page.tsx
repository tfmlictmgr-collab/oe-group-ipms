import Link from "next/link";
import { ShieldCheck, XCircle } from "lucide-react";
import { roleLabel } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { previewInvitation } from "./actions";
import AcceptForm from "./AcceptForm";

// Public route — deliberately outside /dashboard, since the invitee has no
// account yet and middleware would bounce them to /login.
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const invite = await previewInvitation(token);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <span
            className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
          >
            OE
          </span>
          <span className="font-semibold">OE Group Portal</span>
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
