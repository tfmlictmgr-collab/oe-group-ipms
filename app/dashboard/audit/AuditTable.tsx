"use client";

import * as React from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatAuditTime } from "@/lib/audit-format";

export type AuditRow = {
  id: string;
  at: string;
  subject: string;
  what: string;
  /** The raw action name, kept small for whoever needs to be exact. */
  code: string;
  actor: string;
  actorRole: string | null;
  /** No person acted — a service or a scheduled job did. */
  automatic: boolean;
  /** The trail had no actor; the record itself named them. */
  fromRecord: boolean;
  kind: "test" | "demo" | null;
  property: string | null;
  about: string | null;
  href: string | null;
  tone: "success" | "destructive" | "muted";
};

/**
 * The trail's table, searchable in place — the "Enter search value" box the
 * old desktop log had, over the rows already loaded. The server decided which
 * rows this reader may see; the search only narrows them.
 */
export default function AuditTable({
  rows,
  limit,
  limits,
  typeKey,
  hasLabelled,
}: {
  rows: AuditRow[];
  limit: number;
  limits: number[];
  typeKey: string;
  hasLabelled: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.subject, r.what, r.code, r.actor, r.actorRole, r.property, r.about]
        .some((v) => (v ?? "").toLowerCase().includes(q))
    );
  }, [rows, query]);

  const hrefFor = (n: number) => {
    const q = new URLSearchParams();
    if (typeKey !== "all") q.set("type", typeKey);
    if (n !== 200) q.set("limit", String(n));
    return `/dashboard/audit${q.toString() ? `?${q}` : ""}`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3" data-print="screen-only">
        <div className="relative w-full sm:w-auto sm:min-w-0 sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by person, property, reference or what happened…"
            aria-label="Search the audit trail"
            className="pl-9"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {visible.length.toLocaleString()} of the latest {rows.length.toLocaleString()} shown
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground sm:ml-auto">
          Show the latest
          {limits.map((n) => (
            <Link
              key={n}
              href={hrefFor(n)}
              className={cn(
                "rounded-md border px-2 py-1 font-medium",
                n === limit ? "border-transparent bg-muted text-foreground" : "border-border hover:text-foreground"
              )}
            >
              {n.toLocaleString()}
            </Link>
          ))}
        </span>
      </div>

      {hasLabelled && (
        <p className="text-xs text-muted-foreground" data-print="screen-only">
          Rows marked <Badge variant="warning" className="mx-0.5">Automated test</Badge> were written by the
          system&apos;s own checks, and <Badge variant="muted" className="mx-0.5">Demo account</Badge> by a
          demonstration login — neither is a real person&apos;s decision. They stay in the trail, because
          nothing is ever removed from it.
        </p>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Time</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="min-w-[18rem]">What happened</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Property</TableHead>
                <TableHead>About</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                    {formatAuditTime(r.at)}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={r.tone === "success" ? "success" : r.tone === "destructive" ? "destructive" : "muted"} className="whitespace-nowrap">
                      {r.subject}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    {r.what}
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{r.code}</span>
                  </TableCell>
                  <TableCell className="align-top text-sm">
                    <span className={cn(r.automatic && "text-muted-foreground")}>{r.actor}</span>
                    {r.actorRole && <span className="block text-xs text-muted-foreground">{r.actorRole}</span>}
                    {r.fromRecord && (
                      <span className="block text-[10px] text-muted-foreground" title="Recorded by the server on their behalf; the name comes from the record itself.">
                        named on the record
                      </span>
                    )}
                    {r.kind === "test" && <Badge variant="warning" className="mt-1">Automated test</Badge>}
                    {r.kind === "demo" && <Badge variant="muted" className="mt-1">Demo account</Badge>}
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">{r.property ?? "—"}</TableCell>
                  <TableCell className="align-top text-sm">
                    {r.href ? (
                      <Link href={r.href} className="font-mono text-xs text-brand underline-offset-2 hover:underline">
                        {r.about ?? "Open"}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">{r.about ?? "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      {visible.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">Nothing in these rows matches that search.</p>
      )}
    </div>
  );
}
