import { CheckCircle2, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/invitation";

// Public. The raw token never leaves this server: it is hashed before the
// lookup, and the RPC returns only true/false so a bad token cannot be probed
// for information.
export default async function ConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirm_vendor_application_email", {
    p_token_hash: hashInviteToken(token),
  });
  const confirmed = !error && data === true;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-6 text-center shadow-sm">
        {confirmed ? (
          <>
            <CheckCircle2 className="mx-auto size-10 text-success" />
            <h1 className="text-lg font-semibold">Email confirmed</h1>
            <p className="text-sm text-muted-foreground">
              Thank you. Your application is now with our team for review — we&apos;ll
              be in touch once a decision is made.
            </p>
          </>
        ) : (
          <>
            <XCircle className="mx-auto size-10 text-destructive" />
            <h1 className="text-lg font-semibold">This link isn&apos;t valid</h1>
            <p className="text-sm text-muted-foreground">
              It may have already been used, or the application may have been
              decided. Your application is unaffected — no further action is needed.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
