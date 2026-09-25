import type { EmailMessage } from "./email.js";

// Merchant-controlled strings (business name, invoice number, metadata) are
// escaped everywhere: emails must not become an HTML-injection vector.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Also strip newlines from subject/text fields (header-injection hygiene).
const line = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const usd = (a: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(a));
const date = (d: Date) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(d) + " UTC";

function layout(title: string, bodyHtml: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #e4e4e7;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:20px">${title}</h1>${bodyHtml}
</td></tr></table>
<p style="max-width:520px;font-size:12px;color:#71717a;line-height:1.5">${footer}</p>
</td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#1d4ed8;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;

const NON_CUSTODIAL = "Payments go directly to the merchant or their licensed payment partner. coin.new never holds your funds.";

interface InvoiceCtx {
  merchantName: string;
  invoiceNumber: string;
  amountUsd: string;
  checkoutUrl: string;
  expiresAt: Date | null;
}

export function invoiceIssued(c: InvoiceCtx): Omit<EmailMessage, "to"> {
  const due = c.expiresAt ? `Pay by ${date(c.expiresAt)}.` : "";
  return {
    subject: line(`Invoice ${c.invoiceNumber} from ${c.merchantName}: ${usd(c.amountUsd)}`),
    html: layout(
      `${esc(c.merchantName)} sent you an invoice`,
      `<p style="font-size:32px;font-weight:700;margin:0">${usd(c.amountUsd)}</p>
       <p style="color:#52525b;margin:4px 0 0">Invoice ${esc(c.invoiceNumber)}${due ? ` · ${esc(due)}` : ""}</p>
       ${button(c.checkoutUrl, "View and pay invoice")}
       <p style="font-size:13px;color:#52525b">Pay with USDC/USDT from any wallet, or by bank transfer or card where offered.</p>`,
      `${NON_CUSTODIAL} Only pay through the link above. coin.new will never ask you to send funds to an address by email.`,
    ),
    text: `${line(c.merchantName)} sent you invoice ${line(c.invoiceNumber)} for ${usd(c.amountUsd)}. ${due}\n\nView and pay: ${c.checkoutUrl}\n\n${NON_CUSTODIAL}`,
  };
}

export function invoiceReminder(c: InvoiceCtx): Omit<EmailMessage, "to"> {
  return {
    subject: line(`Reminder: invoice ${c.invoiceNumber} from ${c.merchantName} expires soon`),
    html: layout(
      "Your invoice expires soon",
      `<p>Invoice ${esc(c.invoiceNumber)} from ${esc(c.merchantName)} for <strong>${usd(c.amountUsd)}</strong> expires ${c.expiresAt ? esc(date(c.expiresAt)) : "soon"}.</p>
       ${button(c.checkoutUrl, "Pay now")}`,
      NON_CUSTODIAL,
    ),
    text: `Invoice ${line(c.invoiceNumber)} from ${line(c.merchantName)} for ${usd(c.amountUsd)} expires soon.\n\nPay: ${c.checkoutUrl}`,
  };
}

interface PaidCtx extends InvoiceCtx {
  paidAmount: string;
  token: string;
  via: string;
  txUrl: string | null;
}

export function paymentReceipt(c: PaidCtx): Omit<EmailMessage, "to"> {
  return {
    subject: line(`Receipt: invoice ${c.invoiceNumber} paid`),
    html: layout(
      "Payment received",
      `<p>Your payment of <strong>${esc(c.paidAmount)} ${esc(c.token)}</strong> for invoice ${esc(c.invoiceNumber)} from ${esc(c.merchantName)} (${usd(c.amountUsd)}) has been confirmed via ${esc(c.via)}.</p>
       ${c.txUrl ? `<p><a href="${esc(c.txUrl)}">View transaction</a></p>` : ""}`,
      NON_CUSTODIAL,
    ),
    text: `Payment of ${c.paidAmount} ${c.token} for invoice ${line(c.invoiceNumber)} from ${line(c.merchantName)} confirmed via ${c.via}.${c.txUrl ? `\n${c.txUrl}` : ""}`,
  };
}

export function paymentReceivedMerchant(c: PaidCtx & { dashboardUrl: string; riskFlags: string[] }): Omit<EmailMessage, "to"> {
  const flagged = c.riskFlags.length ? `⚠️ Flagged: ${c.riskFlags.join(", ").replace(/_/g, " ")}. Review before fulfilling.` : "";
  return {
    subject: line(`${flagged ? "[Review] " : ""}Invoice ${c.invoiceNumber} paid: ${c.paidAmount} ${c.token}`),
    html: layout(
      `Invoice ${esc(c.invoiceNumber)} is paid`,
      `<p><strong>${esc(c.paidAmount)} ${esc(c.token)}</strong> received via ${esc(c.via)} for ${usd(c.amountUsd)}.</p>
       ${flagged ? `<p style="background:#fef2f2;color:#991b1b;padding:8px 12px;border-radius:6px">${esc(flagged)}</p>` : ""}
       ${button(c.dashboardUrl, "Open in dashboard")}`,
      "You receive this because payment notifications are on for your coin.new account.",
    ),
    text: `Invoice ${line(c.invoiceNumber)} paid: ${c.paidAmount} ${c.token} via ${c.via}. ${flagged}\n${c.dashboardUrl}`,
  };
}
