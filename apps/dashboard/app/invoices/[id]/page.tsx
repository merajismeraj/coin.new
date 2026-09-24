import type { InvoiceWithSettlements } from "@coinnew/shared-types";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiRequestError, authedApi } from "@/lib/api";
import { CopyButton } from "@/components/copy-button";
import { SubmitButton } from "@/components/submit-button";
import { Card, StatusBadge, date, usd } from "@/components/ui";
import { cancelInvoice } from "../../actions";

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-2.5 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="col-span-2 break-words">{children}</dd>
    </div>
  );
}

export default async function InvoicePage({ params }: { params: { id: string } }) {
  let inv: InvoiceWithSettlements;
  try {
    inv = await authedApi<InvoiceWithSettlements>(`/v1/invoices/${params.id}`);
  } catch (e) {
    if (e instanceof ApiRequestError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const cancel = cancelInvoice.bind(null, inv.id);

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">← Invoices</Link>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{inv.invoice_number}</h1>
            <StatusBadge status={inv.status} />
          </div>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{usd(inv.amount_usd)}</p>
        </div>
        {inv.status === "pending" && (
          <form action={cancel}>
            <SubmitButton variant="danger" pendingText="Canceling…">Cancel invoice</SubmitButton>
          </form>
        )}
      </div>

      <Card title="Checkout link">
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">{inv.checkout_url}</code>
          <CopyButton value={inv.checkout_url} />
          <a href={inv.checkout_url} target="_blank" rel="noreferrer" className="rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            Open
          </a>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Details">
          <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
            <Row label="Buyer">{inv.buyer_email ?? "—"}</Row>
            <Row label="Tokens">{inv.accepted_tokens.join(", ")}</Row>
            <Row label="Chains"><span className="capitalize">{inv.accepted_chains.join(", ")}</span></Row>
            <Row label="Created">{date(inv.created_at)}</Row>
            <Row label="Expires">{inv.expires_at ? date(inv.expires_at) : "Never"}</Row>
            {Object.entries(inv.metadata).map(([k, v]) => (
              <Row key={k} label={k}><span className="font-mono text-xs">{String(v)}</span></Row>
            ))}
          </dl>
        </Card>
        <Card title="Settlements">
          {inv.settlements.length === 0 ? (
            <p className="text-sm text-zinc-500">No payments observed yet. Settlements appear here as they’re confirmed on-chain or by the partner rail.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {inv.settlements.map((s) => (
                <li key={s.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="font-medium">{s.amount} {s.token} <span className="text-zinc-500">via {s.chain ?? s.rail}</span></div>
                  {s.tx_hash && <div className="mt-1 truncate font-mono text-xs text-zinc-500">{s.tx_hash}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
