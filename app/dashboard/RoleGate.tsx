// Page-level role guard. RLS is the security backstop (it returns no data to a
// role that shouldn't see it), but restricted roles reaching a privileged route
// directly should get a clean message rather than an empty UI shell. Render this
// in place of the page body when the role isn't allowed.
export default function RoleGate({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-xl font-semibold text-neutral-800">{title}</h1>
      <p className="mt-2 text-sm text-neutral-500">
        This section isn&apos;t available for your role. Use the menu above for
        the areas you have access to.
      </p>
    </div>
  );
}

export function roleAllowed(
  role: string | undefined,
  allowed: string[]
): boolean {
  return allowed.includes(role ?? "");
}
