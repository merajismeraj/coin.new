import { randomUUID } from "node:crypto";
import { billingPeriods, invoices, merchants, type Db } from "@coinnew/db";
import { TOKENS, type BillingPeriod, type BillingSummary } from "@coinnew/shared-types";
import { and, desc, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";
import type { Config } from "../config.js";
import { isUniqueViolation } from "../lib/errors.js";
import { billingInvoiceIssued, billingReminder } from "./email-templates.js";
import { enqueueEmail } from "./email.js";

/*
 * Subscription billing. The plan starts with a merchant's first confirmed
 * payment; each monthly period is billed in advance as an ordinary invoice
 * issued by the platform's own merchant account. Paying it goes through the
 * normal checkout and on-chain verification, so coin.new never takes custody
 * of merchant funds to collect its fee: the merchant pays the bill like any
 * other invoice. A bill unpaid past its due date pauses new invoice creation.
 */

type BillingConfig = NonNullable<Config["billing"]>;
const DAY = 86_400_000;
const REMINDER_BEFORE_DUE_MS = 3 * DAY;

/** Calendar months after `start`, clamped to the month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(start: Date, n: number): Date {
  const d = new Date(start);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** The billing period containing `now`, counted in whole months from the plan start. */
export function currentPeriod(startedAt: Date, now: Date): { start: Date; end: Date } {
  let n = (now.getUTCFullYear() - startedAt.getUTCFullYear()) * 12 + (now.getUTCMonth() - startedAt.getUTCMonth());
  while (n > 0 && addMonths(startedAt, n) > now) n--;
  while (addMonths(startedAt, n + 1) <= now) n++;
  return { start: addMonths(startedAt, Math.max(0, n)), end: addMonths(startedAt, Math.max(0, n) + 1) };
}

/** Starts the plan on the merchant's first confirmed payment. Idempotent. */
export async function markBillingStarted(db: Db, merchantId: string, at = new Date()) {
  await db.update(merchants).set({ billingStartedAt: at }).where(and(eq(merchants.id, merchantId), isNull(merchants.billingStartedAt)));
}

const yyyymm = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Issues the current period's bill for every merchant whose plan has started. Safe to run concurrently. */
export async function issueBills(db: Db, config: Config, now = new Date()): Promise<number> {
  const billing = config.billing;
  if (!billing) return 0;
  const [platform] = await db.select().from(merchants).where(eq(merchants.id, billing.platformMerchantId));
  if (!platform) throw new Error("BILLING_MERCHANT_ID does not match a merchant");

  const started = await db
    .select({ id: merchants.id, email: merchants.email, startedAt: merchants.billingStartedAt })
    .from(merchants)
    .where(and(isNotNull(merchants.billingStartedAt), ne(merchants.id, platform.id)));
  let issued = 0;
  for (const m of started) {
    const period = currentPeriod(m.startedAt!, now);
    const [existing] = await db
      .select({ id: billingPeriods.id })
      .from(billingPeriods)
      .where(and(eq(billingPeriods.merchantId, m.id), eq(billingPeriods.periodStart, period.start)));
    if (existing) continue;
    if (await issueBill(db, config, billing, platform, m, period, now)) issued++;
  }
  return issued;
}

class AlreadyIssued extends Error {}

async function issueBill(
  db: Db,
  config: Config,
  billing: BillingConfig,
  platform: typeof merchants.$inferSelect,
  m: { id: string; email: string },
  period: { start: Date; end: Date },
  now: Date,
): Promise<boolean> {
  const id = randomUUID();
  const dueAt = new Date(now.getTime() + billing.graceDays * DAY);
  try {
    await db.transaction(async (tx) => {
      const [inv] = await tx
        .insert(invoices)
        .values({
          id,
          merchantId: platform.id,
          invoiceNumber: `CN-${yyyymm(period.start)}-${m.id.replace(/-/g, "").slice(0, 12).toUpperCase()}`,
          amountUsd: billing.priceUsd,
          acceptedTokens: [...TOKENS],
          acceptedChains: platform.preferredChains,
          buyerEmail: m.email,
          checkoutUrl: `${config.checkoutBaseUrl}/i/${id}`,
          // Bills stay payable after the due date; being late only pauses new invoices.
          expiresAt: null,
          metadata: { type: "subscription", billed_merchant_id: m.id, period_start: period.start.toISOString() },
        })
        .returning();
      const [row] = await tx
        .insert(billingPeriods)
        .values({ merchantId: m.id, periodStart: period.start, periodEnd: period.end, amountUsd: billing.priceUsd, invoiceId: inv!.id, dueAt })
        .onConflictDoNothing()
        .returning();
      // Another runner billed this period first: roll back our invoice.
      if (!row) throw new AlreadyIssued();
      await enqueueEmail(tx as unknown as Db, {
        template: "billing_invoice",
        merchantId: m.id,
        invoiceId: inv!.id,
        to: m.email,
        ...billingInvoiceIssued({ amountUsd: billing.priceUsd, periodStart: period.start, periodEnd: period.end, dueAt, payUrl: inv!.checkoutUrl, dashboardUrl: config.email.dashboardUrl }),
      });
    });
    return true;
  } catch (e) {
    // Another runner billed this period: either unique constraint (period or invoice number) can trip first.
    if (e instanceof AlreadyIssued || isUniqueViolation(e)) return false;
    throw e;
  }
}

/** One reminder per bill, three days before it's due, if it's still unpaid. */
export async function sendBillingReminders(db: Db, config: Config, now = new Date()): Promise<number> {
  if (!config.billing) return 0;
  const due = await db
    .select({ period: billingPeriods, invoice: invoices, email: merchants.email })
    .from(billingPeriods)
    .innerJoin(invoices, eq(invoices.id, billingPeriods.invoiceId))
    .innerJoin(merchants, eq(merchants.id, billingPeriods.merchantId))
    .where(and(isNull(billingPeriods.reminderSentAt), eq(invoices.status, "pending"), lte(billingPeriods.dueAt, new Date(now.getTime() + REMINDER_BEFORE_DUE_MS))));
  let sent = 0;
  for (const r of due) {
    // Claim first so concurrent runners send once.
    const [claimed] = await db
      .update(billingPeriods)
      .set({ reminderSentAt: now })
      .where(and(eq(billingPeriods.id, r.period.id), isNull(billingPeriods.reminderSentAt)))
      .returning({ id: billingPeriods.id });
    if (!claimed) continue;
    await enqueueEmail(db, {
      template: "billing_reminder",
      merchantId: r.period.merchantId,
      invoiceId: r.invoice.id,
      to: r.email,
      ...billingReminder({ amountUsd: r.period.amountUsd, dueAt: r.period.dueAt, payUrl: r.invoice.checkoutUrl, overdue: r.period.dueAt <= now }),
    });
    sent++;
  }
  return sent;
}

/** A bill still unpaid after its due date. Canceling the bill's invoice waives it. */
export async function isPastDue(db: Db, merchantId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: billingPeriods.id })
    .from(billingPeriods)
    .innerJoin(invoices, eq(invoices.id, billingPeriods.invoiceId))
    .where(and(eq(billingPeriods.merchantId, merchantId), eq(invoices.status, "pending"), lte(billingPeriods.dueAt, now)))
    .limit(1);
  return !!row;
}

function periodStatus(invoiceStatus: string, dueAt: Date, now: Date): BillingPeriod["status"] {
  if (invoiceStatus === "paid") return "paid";
  if (invoiceStatus === "processing") return "processing";
  if (invoiceStatus === "canceled") return "waived";
  return dueAt <= now ? "past_due" : "due";
}

export async function billingSummary(db: Db, config: Config, merchantId: string, now = new Date()): Promise<BillingSummary> {
  const [m] = await db.select({ startedAt: merchants.billingStartedAt }).from(merchants).where(eq(merchants.id, merchantId));
  const billing = config.billing;
  const priceUsd = billing?.priceUsd ?? "10.00";
  if (!billing || merchantId === billing.platformMerchantId) {
    return { enabled: false, price_usd: priceUsd, status: "free", started_at: m?.startedAt?.toISOString() ?? null, next_bill_at: null, periods: [] };
  }
  const rows = await db
    .select({ period: billingPeriods, invoiceNumber: invoices.invoiceNumber, invoiceStatus: invoices.status, payUrl: invoices.checkoutUrl })
    .from(billingPeriods)
    .innerJoin(invoices, eq(invoices.id, billingPeriods.invoiceId))
    .where(eq(billingPeriods.merchantId, merchantId))
    .orderBy(desc(billingPeriods.periodStart))
    .limit(24);
  const periods: BillingPeriod[] = rows.map((r) => ({
    id: r.period.id,
    period_start: r.period.periodStart.toISOString(),
    period_end: r.period.periodEnd.toISOString(),
    amount_usd: r.period.amountUsd,
    status: periodStatus(r.invoiceStatus, r.period.dueAt, now),
    due_at: r.period.dueAt.toISOString(),
    invoice_number: r.invoiceNumber,
    pay_url: r.payUrl,
  }));
  const startedAt = m?.startedAt ?? null;
  return {
    enabled: true,
    price_usd: priceUsd,
    status: !startedAt ? "free" : periods.some((p) => p.status === "past_due") ? "past_due" : "active",
    started_at: startedAt?.toISOString() ?? null,
    next_bill_at: startedAt ? currentPeriod(startedAt, now).end.toISOString() : null,
    periods,
  };
}
