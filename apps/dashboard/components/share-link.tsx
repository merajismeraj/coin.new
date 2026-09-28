import { CopyButton } from "./copy-button";

const btn = "inline-flex items-center justify-center rounded-md border border-zinc-300 px-3.5 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

/** The one thing a merchant needs after creating an invoice: get the link to the client. */
export function ShareLink({ url, invoiceNumber, amount, buyerEmail }: { url: string; invoiceNumber: string; amount: string; buyerEmail: string | null }) {
  const message = `Hi,\n\nHere's the payment link for invoice ${invoiceNumber} (${amount}):\n${url}\n\nYou can pay with USDC or USDT from your wallet or exchange.\n\nThank you!`;
  const mailto = `mailto:${buyerEmail ?? ""}?${new URLSearchParams({ subject: `Invoice ${invoiceNumber} (${amount})`, body: message }).toString().replace(/\+/g, "%20")}`;
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(message)}`;
  return (
    <section className="rounded-lg border-2 border-brand/30 bg-blue-50/60 p-5 dark:border-blue-900 dark:bg-blue-950/30">
      <h2 className="text-base font-semibold">Share this payment link</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {buyerEmail ? `We emailed it to ${buyerEmail}. You can also send it yourself.` : "Send it to your client by email or chat. They pay in a few clicks, no account needed."}
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-md border border-zinc-200 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900">{url}</code>
        <CopyButton value={url} label="Copy link" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={mailto} className={btn}>Email</a>
        <a href={whatsapp} target="_blank" rel="noreferrer" className={btn}>WhatsApp</a>
        <a href={url} target="_blank" rel="noreferrer" className={btn}>Preview checkout ↗</a>
      </div>
    </section>
  );
}
