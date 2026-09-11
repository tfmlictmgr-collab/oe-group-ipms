import { Suspense } from "react";
import ConfirmResetForm from "./ConfirmResetForm";

export const metadata = { title: "Set a new password", robots: { index: false, follow: false } };

export default function ResetPasswordConfirmPage() {
  return (
    <main
      className="bg-brand-wash flex min-h-screen items-center justify-center px-5 py-10"
      style={{ ["--brand" as string]: "#003366" }}
    >
      <div className="w-full max-w-sm">
        {/* useSearchParams needs a Suspense boundary in the App Router. */}
        <Suspense fallback={null}>
          <ConfirmResetForm />
        </Suspense>
      </div>
    </main>
  );
}
