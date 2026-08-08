import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import MfaSettings from "./MfaSettings";

// Open to every role, same as My Profile and My Notifications: this is a
// person's own account security, not organisation configuration.
export const dynamic = "force-dynamic";

export default async function SecuritySettingsPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>
            An extra step at sign-in, on top of your password. Nothing here changes anything for
            anyone else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MfaSettings />
        </CardContent>
      </Card>
    </div>
  );
}
