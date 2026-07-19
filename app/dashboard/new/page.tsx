import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import NewRequestForm from "./NewRequestForm";

export default async function NewRequestPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-1 text-xl font-semibold text-neutral-800">
        New Service Request
      </h1>
      <p className="mb-6 text-sm text-neutral-500">
        Describe the issue. Our team is notified as soon as you submit.
      </p>
      <NewRequestForm orgId={session.profile!.org_id} />
    </div>
  );
}
