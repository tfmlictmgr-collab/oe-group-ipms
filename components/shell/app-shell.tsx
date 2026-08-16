"use client";

import * as React from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { BrandMark } from "./brand-mark";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { NotificationBell, type UserNotification } from "./notification-bell";
import type { NavContext } from "./nav-config";

export type ShellUser = {
  name: string;
  email: string;
  roleLabel: string;
};

export function AppShell({
  brandName,
  orgName,
  logoText,
  logoUrl,
  portalName,
  supportEmail,
  supportPhone,
  user,
  ctx,
  notifications,
  children,
}: {
  brandName: string;
  orgName: string;
  logoText?: string | null;
  logoUrl?: string | null;
  portalName: string;
  supportEmail?: string | null;
  supportPhone?: string | null;
  user: ShellUser;
  ctx: NavContext;
  notifications: UserNotification[];
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop sidebar */}
      {/* Desktop sidebar. `print:hidden` — the navigation is not part of any
          report, and printed at 64 units wide it would push every page's
          content off the right edge of the sheet. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar lg:flex print:hidden">
        <div className="flex h-16 items-center border-b border-sidebar-border px-5">
          <BrandMark name={brandName} logoText={logoText} logoUrl={logoUrl} subtitle={portalName} />
        </div>
        <SidebarNav ctx={ctx} />
        <div className="space-y-0.5 border-t border-sidebar-border px-5 py-3">
          <p className="truncate text-xs text-sidebar-muted">{orgName}</p>
          {supportEmail && (
            <a
              href={`mailto:${supportEmail}`}
              className="block truncate text-[0.7rem] text-sidebar-muted/80 hover:text-white"
            >
              {supportEmail}
            </a>
          )}
          {supportPhone && (
            <p className="truncate text-[0.7rem] text-sidebar-muted/80">{supportPhone}</p>
          )}
        </div>
      </aside>

      {/* Main column. The sidebar offset comes off in print, since the sidebar
          itself is gone. */}
      <div className="lg:pl-64 print:pl-0">
        {/* Top bar */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-6 print:hidden">
          {/* Mobile: hamburger + drawer */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="flex h-16 items-center border-b border-sidebar-border px-5">
                <BrandMark name={brandName} logoText={logoText} logoUrl={logoUrl} subtitle={portalName} />
              </div>
              <SidebarNav ctx={ctx} onNavigate={() => setMobileOpen(false)} />
              <div className="border-t border-sidebar-border px-5 py-3">
                <p className="truncate text-xs text-sidebar-muted">{orgName}</p>
              </div>
            </SheetContent>
          </Sheet>

          {/* Brand on mobile (sidebar hidden) */}
          <div className="flex min-w-0 flex-1 items-center lg:hidden">
            <BrandMark name={brandName} logoText={logoText} logoUrl={logoUrl} onDark={false} />
          </div>
          <div className="hidden flex-1 lg:block" />

          <div className="flex items-center gap-1 sm:gap-2">
            <NotificationBell initial={notifications} />
            <ThemeToggle />
            <UserMenu
              name={user.name}
              email={user.email}
              roleLabel={user.roleLabel}
              isAdmin={ctx.isAdmin}
            />
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl animate-fade-in px-4 py-6 sm:px-6 sm:py-8 print:max-w-none print:p-0">
          {children}
        </main>
      </div>
    </div>
  );
}
