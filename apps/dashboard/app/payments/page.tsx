import { riskFlagsOf, type Invoice, type Page, type SettlementListItem, type UnmatchedTransfer } from "@coinnew/shared-types";
import Link from "next/link";
import { authedApi } from "@/lib/api";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, Input, Select, date, usd } from "@/components/ui";
import { assignTransfer, dismissTransfer } from "../actions";

export const dynamic = "force-dynamic";

const RAILS = [
  ["", "All rails"],
  ["onchain", "On-chain"],
  ["bridge", "Bank transfer (Bridge)"],
  ["moonpay", "Card (MoonPay)"],
] as const;

const via = (s: SettlementListItem) => (s.rail === "onchain" ? `${s.chain} transfer` : s.method === "bank_transfer" ? "Bank transfer" : "Card");

export default async function PaymentsPage({ searchParams }: { searchParams: { rail?: string; cursor?: string; error?: string } }) {
  const rail = RAILS.find(([r]) => r && r === searchParams.rail)?.[0];
  const qs = new URLSearchParams({ limit: "50", ...(rail && { rail }), ...(searchParams.cursor && { cursor: searchParams.cursor }) });
  const [page, unmatched, pending, expired] = await Promise.all([
    authedApi<Page<SettlementListItem>>(`/v1/settlements?${qs}`),
    authedApi<{ data: UnmatchedTransfer[] }>("/v1/unmatched-transfers"),
    authedApi<Page<Invoice>>("/v1/invoices?status=pending&limit=100"),
    authedApi<Page<Invoice>>("/v1/invoices?status=expired&limit=100"),
  ]);
  const assignable = [...pending.data, ...expired.data];
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <form action="/api/export" method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="space-y-1">
            <span className="block text-xs text-zinc-500">From</span>
            <Input type="date" name="from" defaultValue={monthStart} required className="w-auto" />
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-zinc-500">To</span>
            <Input type="date" name="to" defaultValue={today} required className="w-auto" />
          </label>
          <button className="rounded-md border border-zinc-300 bg-white px-3.5 py-2 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">
            Export CSV
          </button>
        </form>
      </div>
      <ErrorBanner message={searchParams.error} />

      {unmatched.data.length > 0 && (
        <Card title={`Needs reconciliation (${unmatched.data.length})`}>
          <p className="mb-4 text-sm text-zinc-500">
            These transfers reached your receiving address but didn’t match an invoice, usually because an exchange deducted a fee or the buyer sent a
            different amount. Assign each to the invoice it pays, or dismiss it.
          </p>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {unmatched.data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {u.amount} {u.token} <span className="font-normal capitalize text-zinc-500">on {u.chain}</span>
                  </div>
                  <div className="truncate font-mono text-xs text-zinc-500">
                    from {u.from_address ?? "unknown"} · <a href={u.explorer_url} target="_blank" rel="noreferrer" className="hover:text-brand">tx ↗</a> · {date(u.observed_at)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <form action={assignTransfer.bind(null, u.id)} className="flex items-center gap-2">
                    <Select name="invoice_id" required defaultValue="" className="w-56">
                      <option value="" disabled>Assign to invoice…</option>
                      {assignable.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.invoice_number} · {usd(i.amount_usd)}{i.status === "expired" ? " (expired)" : ""}
                        </option>
                      ))}
                    </Select>
                    <SubmitButton pendingText="Assigning…">Assign</SubmitButton>
                  </form>
                  <form action={dismissTransfer.bind(null, u.id)}>
                    <SubmitButton variant="secondary" pendingText="…">Dismiss</SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <nav className="flex gap-1 overflow-x-auto text-sm" aria-label="Filter by rail">
        {RAILS.map(([r, label]) => (
          <Link
            key={r || "all"}
            href={r ? `/payments?rail=${r}` : "/payments"}
            aria-current={(r || undefined) === rail ? "page" : undefined}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-zinc-600 hover:bg-zinc-200 aria-[current=page]:bg-zinc-900 aria-[current=page]:text-white dark:text-zinc-400 dark:hover:bg-zinc-800 dark:aria-[current=page]:bg-zinc-100 dark:aria-[current=page]:text-zinc-900"
          >
            {label}
          </Link>
        ))}
      </nav>

      <Card className="overflow-hidden p-0">
        {page.data.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">No settlements yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Invoice</th>
                  <th className="px-4 py-2.5 text-right font-medium">Received</th>
                  <th className="px-4 py-2.5 font-medium">Via</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {page.data.map((s) => (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <Link href={`/invoices/${s.invoice_id}`} className="font-medium hover:text-brand">{s.invoice_number}</Link>
                      <div className="text-xs text-zinc-500">{usd(s.invoice_amount_usd)}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.amount} {s.token}</td>
                    <td className="px-4 py-3 capitalize">{via(s)}</td>
                    <td className="px-4 py-3">
                      <span className={s.confirmed_at ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>
                        {s.confirmed_at ? "Confirmed" : "Confirming"}
                      </span>
                      {s.risk_flags.includes("manual_match") && <div className="text-xs text-zinc-500">manual match</div>}
                      {riskFlagsOf(s.risk_flags).length > 0 && (
                        <div className="text-xs text-red-600 dark:text-red-400">{riskFlagsOf(s.risk_flags).join(", ").replace(/_/g, " ")}</div>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-zinc-500 md:table-cell">{date(s.confirmed_at ?? s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {page.next_cursor && (
        <div className="flex justify-center">
          <Link href={`/payments?${new URLSearchParams({ ...(rail && { rail }), cursor: page.next_cursor })}`} className="text-sm text-brand hover:underline">
            Older payments →
          </Link>
        </div>
      )}
    </div>
  );
}
