"use client";

import * as React from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import RentRollActions from "./RentRollActions";

export type RentRollRow = {
  lease_id: string;
  property_name: string;
  unit_label: string;
  tenant_name: string | null;
  tenant_email: string | null;
  tenant_phone: string | null;
  /** True when the name is the tenant OF RECORD rather than a portal account. */
  of_record: boolean;
  status: string;
  start_date: string;
  end_date: string;
  days_to_expiry: number;
  rent_amount: number;
  rent_frequency: string;
  rent_outstanding: number;
  landlord_net: number;
};

const STATUS_VARIANT: Record<string, "success" | "outline" | "muted" | "destructive"> = {
  active: "success", renewed: "success", draft: "outline",
  expired: "destructive", terminated: "muted",
};

const naira = (n: number) =>
  `₦${Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

// Timezone pinned: this renders on the server AND hydrates in the browser, and
// an unpinned date is a hydration mismatch for anyone not on Lagos time.
const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString("en-NG", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Lagos",
  });

/**
 * The fields a person can search by, each with the text it is matched against.
 *
 * Asked for directly (11 Sept 2026): "make the lease/rent searchable by the
 * fields". Each field is matched against what the row DISPLAYS as well as its
 * raw value — a person reading "₦6,000,000" types "6,000,000" or "6000000",
 * and one reading "27 Oct 2026" types "oct 2026" — so the search answers to the
 * screen they are looking at rather than to the database's spelling of it.
 */
const FIELDS: { key: string; label: string; text: (r: RentRollRow) => string }[] = [
  { key: "unit", label: "Unit", text: (r) => r.unit_label },
  { key: "property", label: "Property", text: (r) => r.property_name },
  { key: "tenant", label: "Tenant", text: (r) => r.tenant_name ?? "not recorded" },
  { key: "contact", label: "Email / phone", text: (r) => [r.tenant_email, r.tenant_phone].join(" ") },
  { key: "status", label: "Status", text: (r) => r.status },
  {
    key: "term", label: "Term dates",
    text: (r) => [r.start_date, r.end_date, fmt(r.start_date), fmt(r.end_date)].join(" "),
  },
  {
    key: "rent", label: "Rent",
    text: (r) => [String(r.rent_amount), naira(r.rent_amount), r.rent_frequency].join(" "),
  },
  {
    key: "outstanding", label: "Outstanding",
    text: (r) => [String(r.rent_outstanding), naira(r.rent_outstanding)].join(" "),
  },
];

const STATUS_FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "live", label: "Live (active or renewed)" },
  { key: "expiring", label: "Ending within 90 days" },
  { key: "owing", label: "Rent outstanding" },
  { key: "active", label: "Active" },
  { key: "renewed", label: "Renewed" },
  { key: "draft", label: "Draft" },
  { key: "expired", label: "Expired" },
  { key: "terminated", label: "Terminated" },
] as const;

function norm(s: string): string {
  // Commas and currency signs out, so "6,000,000", "₦6000000" and "6000000"
  // all find the same rent.
  return s.toLowerCase().replace(/[,₦]/g, "");
}

export default function RentRollTable({
  rows,
  canWrite,
}: {
  rows: RentRollRow[];
  canWrite: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const [field, setField] = React.useState("all");
  const [status, setStatus] = React.useState<string>("all");

  const visible = React.useMemo(() => {
    const words = norm(query.trim()).split(/\s+/).filter(Boolean);
    const fields = field === "all" ? FIELDS : FIELDS.filter((f) => f.key === field);
    return rows.filter((r) => {
      const live = r.status === "active" || r.status === "renewed";
      if (status === "live" && !live) return false;
      if (status === "expiring" && !(live && r.days_to_expiry >= 0 && r.days_to_expiry <= 90)) return false;
      if (status === "owing" && !(Number(r.rent_outstanding) > 0)) return false;
      if (!["all", "live", "expiring", "owing"].includes(status) && r.status !== status) return false;
      if (words.length === 0) return true;
      const hay = norm(fields.map((f) => f.text(r)).join(" "));
      return words.every((w) => hay.includes(w));
    });
  }, [rows, query, field, status]);

  const filtered = query.trim() !== "" || status !== "all";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative w-full sm:w-auto sm:min-w-0 sm:max-w-sm sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              field === "all"
                ? "Search unit, property, tenant, email, status, dates, rent…"
                : `Search by ${FIELDS.find((f) => f.key === field)?.label.toLowerCase()}…`
            }
            aria-label="Search tenancies"
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Field to search"
          value={field}
          onChange={(e) => setField(e.target.value)}
          className="w-auto"
        >
          <option value="all">All fields</option>
          {FIELDS.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-auto"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </Select>
        {filtered && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { setQuery(""); setStatus("all"); setField("all"); }}
          >
            <X className="size-4" /> Clear
          </Button>
        )}
        <span className="text-xs text-muted-foreground sm:ml-auto">
          {visible.length} of {rows.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">
          No tenancy matches that search.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>Term</TableHead>
                <TableHead className="text-right">Rent</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead className="text-right">Landlord net</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.lease_id}>
                  <TableCell>
                    {/* The row's own statement, one click away. The stat tiles
                        above have linked here since 0225; the table the tiles
                        summarise never did. */}
                    <Link
                      href={`/dashboard/leases/${r.lease_id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {r.unit_label}
                    </Link>
                    <span className="block text-xs text-muted-foreground">{r.property_name}</span>
                  </TableCell>
                  <TableCell>
                    {r.tenant_name ?? <span className="text-muted-foreground">Not recorded</span>}
                    {(r.tenant_email || r.tenant_phone) && (
                      <span className="block text-xs text-muted-foreground">
                        {r.tenant_email ?? r.tenant_phone}
                      </span>
                    )}
                    {r.of_record && (
                      <span className="block text-xs text-muted-foreground">no portal account</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? "outline"}>{r.status}</Badge>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      to {fmt(r.end_date)}
                      {r.days_to_expiry >= 0 && r.days_to_expiry <= 90 && ` · ${r.days_to_expiry}d`}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {naira(r.rent_amount)}
                    <span className="block text-xs text-muted-foreground">{r.rent_frequency}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Number(r.rent_outstanding) > 0 ? (
                      <span className="font-medium text-destructive">{naira(r.rent_outstanding)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {Number(r.landlord_net) > 0 ? naira(r.landlord_net) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite && (
                      <RentRollActions leaseId={r.lease_id} status={r.status} endDate={r.end_date} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
