import { invoices, merchants, type Db } from "@coinnew/db";
import { and, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { toInvoice } from "../lib/serialize.js";
import { enqueueEmail } from "./email.js";
import { invoiceReminder } from "./email-templates.js";
import { enqueueWebhook } from "./webhooks.js";

/**
 * Persists expiry (reads already report it lazily) and emits invoice.expired.
 * The conditional UPDATE makes it safe to run in several workers: each
 * invoice flips exactly once, so the webhook is sent exactly once.
 */
export async function expireInvoices(db: Db): Promise<number> {
  const expired = await db
    .update(invoices)
    .set({ status: "expired" })
    .where(and(eq(invoices.status, "pending"), isNotNull(invoices.expiresAt), lte(invoices.expiresAt, new Date())))
    .returning();
  for (const inv of expired) {
    await enqueueWebhook(db, { merchantId: inv.merchantId, invoiceId: inv.id, type: "invoice.expired", data: toInvoice(inv) });
  }
  return expired.length;
}

const REMINDER_LEAD_MS = 24 * 3600_000;
/** Only remind on invoices that were open well before the reminder window. */
const REMINDER_MIN_LIFETIME_MS = 48 * 3600_000;

/** One reminder email to the buyer ~24h before an unpaid invoice expires. */
export async function sendExpiryReminders(db: Db): Promise<number> {
  const now = Date.now();
  const due = await db
    .update(invoices)
    .set({ reminderSentAt: new Date() })
    .where(
      and(
        eq(invoices.status, "pending"),
        isNull(invoices.reminderSentAt),
        isNotNull(invoices.buyerEmail),
        gt(invoices.expiresAt, new Date(now + 3600_000)),
        lte(invoices.expiresAt, new Date(now + REMINDER_LEAD_MS)),
        sql`${invoices.expiresAt} - ${invoices.createdAt} >= make_interval(secs => ${REMINDER_MIN_LIFETIME_MS / 1000})`,
      ),
    )
    .returning();
  for (const inv of due) {
    const [m] = await db.select({ name: merchants.businessName }).from(merchants).where(eq(merchants.id, inv.merchantId));
    await enqueueEmail(db, {
      template: "invoice_reminder",
      merchantId: inv.merchantId,
      invoiceId: inv.id,
      to: inv.buyerEmail!,
      ...invoiceReminder({ merchantName: m!.name, invoiceNumber: inv.invoiceNumber, amountUsd: inv.amountUsd, checkoutUrl: inv.checkoutUrl, expiresAt: inv.expiresAt }),
    });
  }
  return due.length;
}
