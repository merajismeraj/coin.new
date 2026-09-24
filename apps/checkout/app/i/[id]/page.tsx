import type { CheckoutInvoice } from "@coinnew/shared-types";
import { notFound } from "next/navigation";
import { Countdown } from "@/components/countdown";
import { PayPanel } from "@/components/pay-panel";
import { Providers } from "@/components/providers";
import { getCheckoutInvoice } from "@/lib/api";

export const dynamic = "force-dynamic";

const usd = (a: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(a));

function Closed({ inv }: { inv: CheckoutInvoice }) {
  const copy: Partial<Record<CheckoutInvoice["status"], [string, string]>> = {
    pending: ["Payment unavailable", `This invoice has no payment method available. Contact ${inv.merchant_name}.`],
    paid: ["Paid", "This invoice has been paid. Thank you!"],
    processing: ["Payment detected", "We’re waiting for final confirmation on-chain."],
    expired: ["Invoice expired", `Ask ${inv.merchant_name} to send a new payment link.`],
    canceled: ["Invoice canceled", `This invoice was canceled by ${inv.merchant_name}.`],
  };
  const [title, body] = copy[inv.status] ?? ["", ""];
  const tone = inv.status === "paid" ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-700 dark:text-zinc-300";
  return (
    <div className="rounded-lg bg-zinc-50 p-4 text-center dark:bg-zinc-800/50">
      <p className={`font-semibold ${tone}`}>{title}</p>
      <p className="mt-1 text-sm text-zinc-500">{body}</p>
      {inv.payment && (
        <a href={inv.payment.explorer_url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-brand hover:underline">
          View transaction ↗
        </a>
      )}
    </div>
  );
}

export default async function CheckoutPage({ params }: { params: { id: string } }) {
  const inv = await getCheckoutInvoice(params.id);
  if (!inv) notFound();

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-500">{inv.merchant_name} requests</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{usd(inv.amount_usd)}</p>
        <div className="mt-2 flex items-center justify-between text-sm text-zinc-500">
          <span>Invoice {inv.invoice_number}</span>
          {inv.status === "pending" && inv.expires_at && <Countdown expiresAt={inv.expires_at} />}
        </div>

        <hr className="my-5 border-zinc-100 dark:border-zinc-800" />

        {inv.status === "pending" && inv.payment_options.length > 0 ? (
          <Providers>
            <PayPanel invoice={inv} />
          </Providers>
        ) : (
          <Closed inv={inv} />
        )}
      </div>

      <p className="px-2 text-center text-xs leading-relaxed text-zinc-500">
        Payments go directly from your wallet to {inv.merchant_name}. coin.new never holds your funds.
      </p>
      <p className="text-center text-xs text-zinc-400">
        Powered by coin<span className="text-brand">.new</span>
      </p>
    </div>
  );
}
