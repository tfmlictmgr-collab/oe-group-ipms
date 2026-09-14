import { cn } from "@/lib/utils";

// Logo lockup. Uses the org's uploaded logo when present, otherwise a
// brand-coloured monogram. `logoText` overrides the two-letter monogram.
export function BrandMark({
  name,
  logoText,
  logoUrl,
  subtitle,
  className,
  onDark = true,
}: {
  name: string;
  logoText?: string | null;
  logoUrl?: string | null;
  subtitle?: string;
  className?: string;
  onDark?: boolean;
}) {
  const mono = (logoText || name).slice(0, 2).toUpperCase();
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      {logoUrl ? (
        // Plain <img>: the URL is a Supabase Storage public object validated by
        // safeLogoUrl(), and next/image would need per-project remotePatterns.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className="h-9 w-9 flex-shrink-0 rounded-lg object-contain"
        />
      ) : (
        <span
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold shadow-sm"
          style={{ background: "var(--brand)", color: "var(--brand-fg)" }}
        >
          {mono}
        </span>
      )}
      <span className="min-w-0 leading-tight">
        <span
          className={cn(
            "block truncate text-sm font-semibold",
            onDark ? "text-white" : "text-foreground"
          )}
        >
          {name}
        </span>
        {subtitle && (
          <span
            className={cn(
              "block truncate text-xs",
              onDark ? "text-sidebar-muted" : "text-muted-foreground"
            )}
          >
            {subtitle}
          </span>
        )}
      </span>
    </div>
  );
}
