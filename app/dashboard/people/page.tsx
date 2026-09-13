import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";

// People — where it opens.
//
// 📌 12 Sept 2026. This was the Members list. It is now part of the Directory,
// which is the administrator's alone ("Member and Directory seems to be a
// duplicity of tools … only platform and org admins should have access"), so
// an administrator opens People on the Directory and everyone else People
// admits — the facilities, property and regional managers — opens it on
// Invitations, which is what they come here to do.
//
// A redirect rather than a page, so the address everybody has bookmarked and
// every "People" link in the product still lands somewhere that answers.
export default async function PeopleIndex() {
  const session = await getSessionProfile();
  if (!session?.profile) redirect("/login");
  redirect(session.profile.role === "admin" ? "/dashboard/people/directory" : "/dashboard/people/invitations");
}
