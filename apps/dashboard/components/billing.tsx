import type { BillingPeriod, BillingSummary } from "@coinnew/shared-types";
import { Card, usd } from "./ui";

const day = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(iso));

const STATUS: Record<BillingPeriod["status"], [string, string]> = {
  paid: ["Paid", "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"],
  processing: ["Confirming", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300"],
  due: ["Due", "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"],
  past_due: ["Past due", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"],
  waived: ["Waived", "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"],
};

const payBtn = "inline-flex shrink-0 rounded-md bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg hover:bg-blue-800";

/** The oldest unpaid bill: the one to act on. */
export const openBill = (b: BillingSummary) => [...b.periods].reverse().find((p) => p.status === "due" || p.status === "past_due");

export function BillingCard({ billing }: { billing: BillingSummary }) {
  if (!billing.enabled) return null;
  const open = openBill(billing);
  return (
    <Card title="Billing">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">coin.new plan · {usd(billing.price_usd)} / month</p>
          <p className="mt-1 text-sm text-zinc-500">
            {billing.status === "free"
              ? "Free until your first payment arrives. Your plan starts then, with no percentage of your payments."
              : `Started ${day(billing.started_at!)}. Next bill ${day(billing.next_bill_at!)}. Unlimited invoices, no percentage of your payments.`}
          </p>
        </div>
        {open && (
          <a href={open.pay_url} target="_blank" rel="noreferrer" className={payBtn}>
            Pay {usd(open.amount_usd)}
          </a>
        )}
      </div>
      {billing.periods.length > 0 && (
        <table className="mt-5 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-2 font-medium">Period</th>
              <th className="py-2 text-right font-medium">Amount</th>
              <th className="py-2 pl-4 font-medium">Status</th>
              <th className="hidden py-2 font-medium sm:table-cell">Due</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {billing.periods.map((p) => {
              const [label, style] = STATUS[p.status];
              return (
                <tr key={p.id}>
                  <td className="py-2.5">{day(p.period_start)} – {day(p.period_end)}</td>
                  <td className="py-2.5 text-right tabular-nums">{usd(p.amount_usd)}</td>
                  <td className="py-2.5 pl-4"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${style}`}>{label}</span></td>
                  <td className="hidden py-2.5 text-zinc-500 sm:table-cell">{day(p.due_at)}</td>
                  <td className="py-2.5 text-right">
                    <a href={p.pay_url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                      {p.status === "due" || p.status === "past_due" ? "Pay" : "View"}
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Shown on every page while a bill is open. */
export function BillingBanner({ billing }: { billing: BillingSummary }) {
  const open = openBill(billing);
  if (!billing.enabled || !open) return null;
  const late = open.status === "past_due";
  return (
    <div className={late ? "border-b border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950" : "border-b border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950"}>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
        <p className={late ? "text-red-900 dark:text-red-200" : "text-amber-900 dark:text-amber-200"}>
          {late
            ? `Your ${usd(open.amount_usd)} coin.new bill is past due. New invoices are paused until it’s paid; existing invoices still work.`
            : `Your ${usd(open.amount_usd)} coin.new bill is due ${day(open.due_at)}.`}
        </p>
        <a href={open.pay_url} target="_blank" rel="noreferrer" className={payBtn}>
          Pay now
        </a>
      </div>
    </div>
  );
}
