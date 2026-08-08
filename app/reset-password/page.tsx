import RequestResetForm from "./RequestResetForm";

// Reachable from every sign-in door (`/login` and every `/o/<slug>`) via one
// shared link — deliberately org-agnostic, since all that's needed at this
// point is an email address; which organisation it belongs to is resolved
// server-side once a real account is found (see actions.ts). Styled like
// /login's own neutral OE Group colours rather than any one brand's, for the
// same reason /login itself stays anonymous.
export const metadata = { title: "Reset your password", robots: { index: false, follow: false } };

export default function ResetPasswordRequestPage() {
  return (
    <main
      className="bg-brand-wash flex min-h-screen items-center justify-center px-5 py-10"
      style={{ ["--brand" as string]: "#003366" }}
    >
      <div className="w-full max-w-sm">
        <RequestResetForm />
      </div>
    </main>
  );
}
