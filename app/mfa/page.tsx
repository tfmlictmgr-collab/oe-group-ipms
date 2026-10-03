import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSessionProfile } from "@/lib/auth";
import { mfaGate, safeNext } from "@/lib/mfa-gate";
import MfaGateFlow from "./MfaGateFlow";

// Where the two-factor gate sends people (0308): to answer the code for a
// session that skipped it, or to set a factor up once their organisation
// requires one. Outside /dashboard on purpose — the gate applies to
// /dashboard, and a page it redirects TO cannot be one it redirects FROM.
export const dynamic = "force-dynamic";
export const metadata = { title: "Two-factor sign-in", robots: { index: false, follow: false } };

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const hasVerifiedFactor = (user.factors ?? []).some(
    (f) => f.factor_type === "totp" && f.status === "verified"
  );
  const [{ data: aal }, { data: enforcedFrom }, session] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.rpc("my_mfa_enforced_from"),
    getSessionProfile(),
  ]);
  const gate = mfaGate({
    hasVerifiedFactor,
    currentLevel: aal?.currentLevel,
    enforcedFrom: (enforcedFrom as string | null) ?? null,
  });

  // Nothing is owed: someone who opened this page directly, or who finished in
  // another tab. Send them on rather than offering a step they do not need —
  // except someone who is merely DUE, who came here to get it done early.
  if (gate.kind === "ok") redirect(target);

  const theme = session?.theme;
  return (
    <main
      className="bg-brand-wash flex min-h-screen items-center justify-center px-4 py-10"
      style={{ ["--brand" as string]: theme?.primary ?? "#003366" }}
    >
      <div className="w-full max-w-md">
        <MfaGateFlow
          // Remount when the gate changes under it — a backup code that removes
          // the factor turns "answer the code" into "set one up" on refresh.
          key={gate.kind}
          mode={gate.kind === "verify" ? "verify" : "enroll"}
          next={target}
          orgName={session?.org?.name ?? theme?.name ?? null}
          required={gate.kind === "enroll"}
        />
      </div>
    </main>
  );
}
