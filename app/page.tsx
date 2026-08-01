import { redirect } from "next/navigation";

// The root sends everyone to the launcher, which is the only page able to decide
// where they actually belong: an operator sees the organisations, a tenant user
// is forwarded to their own dashboard, and a signed-out visitor is sent to sign
// in.
//
// This previously went straight to /dashboard, which is why the launcher — the
// entire point of an operator's session — was reachable by no journey at all.
export default function Home() {
  redirect("/orgs");
}
