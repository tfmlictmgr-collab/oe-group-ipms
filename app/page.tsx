import { redirect } from "next/navigation";
import { orgForCurrentHost } from "@/lib/org-host";

// Where a visit begins.
//
// On a brand's own hostname (portal.tfmlconsultant.com) the root IS that
// brand's front door, so it goes straight there — a TFML employee typing their
// company's portal address should never see a generic OE Group screen, let alone
// a page hinting that other organisations exist.
//
// The platform operator's own hostname (e.g. admin.tfmlconsultant.com) is the
// one deliberate exception: `/o/<slug>` is a CLIENT org's front door — it names
// the org and locks sign-in to it — but the operator's door is /login, which is
// anonymous by design (B1: "reveals nothing about who is on the platform").
// Routing the operator's own domain through /o/oe-group would silently swap the
// anonymous door for the client-facing template, so it is checked first.
//
// On any other host it goes to the launcher, which is the only page able to
// decide where someone belongs: an operator sees the organisations, a tenant
// user is forwarded to their own dashboard, and a signed-out visitor is sent to
// sign in.
export default async function Home() {
  const org = await orgForCurrentHost();
  if (org?.is_platform_operator) redirect("/login");
  if (org?.slug) redirect(`/o/${org.slug}`);
  redirect("/orgs");
}
