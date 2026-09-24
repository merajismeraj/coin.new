import { INVOICE_STATUSES, type Invoice, type Page } from "@coinnew/shared-types";
import Link from "next/link";
import { authedApi } from "@/lib/api";
import { Card, StatusBadge, date, usd } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: { status?: string; cursor?: string } }) {
  const status = INVOICE_STATUSES.find((s) => s === searchParams.status);
  const qs = new URLSearchParams({ limit: "25", ...(status && { status }), ...(searchParams.cursor && { cursor: searchParams.cursor }) });
  const page = await authedApi<Page<Invoice>>(`/v1/invoices?${qs}`);
  const tabs = [undefined, ...INVOICE_STATUSES];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <Link href="/invoices/new" className="rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-brand-fg hover:bg-blue-800">
          New invoice
        </Link>
      </div>

      <nav className="flex gap-1 overflow-x-auto text-sm" aria-label="Filter by status">
        {tabs.map((s) => (
          <Link
            key={s ?? "all"}
            href={s ? `/?status=${s}` : "/"}
            aria-current={s === status ? "page" : undefined}
            className="rounded-md px-3 py-1.5 capitalize text-zinc-600 hover:bg-zinc-200 aria-[current=page]:bg-zinc-900 aria-[current=page]:text-white dark:text-zinc-400 dark:hover:bg-zinc-800 dark:aria-[current=page]:bg-zinc-100 dark:aria-[current=page]:text-zinc-900"
          >
            {s ?? "All"}
          </Link>
        ))}
      </nav>

      <Card className="overflow-hidden p-0">
        {page.data.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">
            {status ? `No ${status} invoices.` : "No invoices yet. Create one and share the checkout link with your client."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
              <tr>
                <th className="px-4 py-2.5 font-medium">Invoice</th>
                <th className="px-4 py-2.5 font-medium">Buyer</th>
                <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {page.data.map((inv) => (
                <tr key={inv.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/invoices/${inv.id}`} className="hover:text-brand">{inv.invoice_number}</Link>
                  </td>
                  <td className="max-w-[12rem] truncate px-4 py-3 text-zinc-500">{inv.buyer_email ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{usd(inv.amount_usd)}</td>
                  <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                  <td className="hidden px-4 py-3 text-zinc-500 sm:table-cell">{date(inv.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {page.next_cursor && (
        <div className="flex justify-center">
          <Link href={`/?${new URLSearchParams({ ...(status && { status }), cursor: page.next_cursor })}`} className="text-sm text-brand hover:underline">
            Older invoices →
          </Link>
        </div>
      )}
    </div>
  );
}
