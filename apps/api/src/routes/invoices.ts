import { randomUUID } from "node:crypto";
import { invoices, merchants, settlements, type Db } from "@coinnew/db";
import { CreateInvoiceBody, ListInvoicesQuery, type Chain, type Page, type Invoice } from "@coinnew/shared-types";
import { and, count, desc, eq, gt, gte, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError, isUniqueViolation, parse } from "../lib/errors.js";
import { effectiveStatus, toInvoice, toSettlement } from "../lib/serialize.js";
import { requireMerchant } from "../plugins/auth.js";
import { enqueueWebhook } from "../services/webhooks.js";
import { enqueueEmail, recentEmails } from "../services/email.js";
import { invoiceIssued } from "../services/email-templates.js";
import { supportedPairs } from "@coinnew/chains";

const IdParams = z.object({ id: z.string().uuid() });

const encodeCursor = (i: { createdAt: Date; id: string }) => Buffer.from(`${i.createdAt.toISOString()}|${i.id}`).toString("base64url");
function decodeCursor(c: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (!id || Number.isNaN(createdAt.getTime())) throw new HttpError(400, "invalid_cursor", "Invalid cursor");
  return { createdAt, id };
}

/** SQL for the *effective* status (expiry applied lazily, see effectiveStatus). */
function statusFilter(status: string): SQL {
  const now = sql`now()`;
  if (status === "expired") return or(eq(invoices.status, "expired"), and(eq(invoices.status, "pending"), lte(invoices.expiresAt, now)))!;
  if (status === "pending") return and(eq(invoices.status, "pending"), or(isNull(invoices.expiresAt), gt(invoices.expiresAt, now)))!;
  return eq(invoices.status, status);
}

export async function invoiceRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  app.addHook("onRequest", requireMerchant(db));

  const loadOwned = async (merchantId: string, id: string) => {
    const [row] = await db.select().from(invoices).where(and(eq(invoices.id, id), eq(invoices.merchantId, merchantId)));
    if (!row) throw new HttpError(404, "not_found", "Invoice not found");
    return row;
  };

  app.post("/v1/invoices", async (req, reply) => {
    const body = parse(CreateInvoiceBody, req.body);
    const merchantId = req.merchantId!;
    const [merchant] = await db.select({ preferredChains: merchants.preferredChains }).from(merchants).where(eq(merchants.id, merchantId));
    const allowed = merchant!.preferredChains as Chain[];
    const chains = body.accepted_chains ?? allowed;
    const unsupported = chains.filter((c) => !allowed.includes(c));
    if (unsupported.length) {
      throw new HttpError(422, "chain_not_enabled", `Chains not enabled for this merchant: ${unsupported.join(", ")}`);
    }
    if (!supportedPairs(config.network, chains, body.accepted_tokens).length) {
      throw new HttpError(422, "no_payment_option", `None of ${body.accepted_tokens.join("/")} is supported on ${chains.join(", ")}`);
    }

    const id = randomUUID();
    const values = {
      id,
      merchantId,
      amountUsd: body.amount_usd,
      acceptedTokens: body.accepted_tokens,
      acceptedChains: chains,
      buyerEmail: body.buyer_email ?? null,
      checkoutUrl: `${config.checkoutBaseUrl}/i/${id}`,
      expiresAt: body.expires_in_hours ? new Date(Date.now() + body.expires_in_hours * 3600_000) : null,
      metadata: body.metadata,
    };

    // Auto-numbering races are resolved by the (merchant_id, invoice_number) unique index + retry.
    for (let attempt = 0; attempt < 5; attempt++) {
      let invoiceNumber = body.invoice_number;
      if (!invoiceNumber) {
        const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(invoices).where(eq(invoices.merchantId, merchantId));
        invoiceNumber = `INV-${String(n + 1 + attempt).padStart(5, "0")}`;
      }
      try {
        const [row] = await db.insert(invoices).values({ ...values, invoiceNumber }).returning();
        if (row!.buyerEmail && body.notify_buyer) await sendInvoiceEmail(db, row!);
        return reply.code(201).send(toInvoice(row!));
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        if (body.invoice_number) throw new HttpError(409, "invoice_number_taken", "invoice_number already exists for this merchant");
      }
    }
    throw new HttpError(409, "invoice_number_conflict", "Could not allocate an invoice number, please retry");
  });

  app.get("/v1/invoices", async (req): Promise<Page<Invoice>> => {
    const q = parse(ListInvoicesQuery, req.query);
    const where: SQL[] = [eq(invoices.merchantId, req.merchantId!)];
    if (q.status) where.push(statusFilter(q.status));
    if (q.created_from) where.push(gte(invoices.createdAt, new Date(q.created_from)));
    if (q.created_to) where.push(lt(invoices.createdAt, new Date(q.created_to)));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(or(lt(invoices.createdAt, c.createdAt), and(eq(invoices.createdAt, c.createdAt), lt(invoices.id, c.id)))!);
    }
    const rows = await db
      .select()
      .from(invoices)
      .where(and(...where))
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return { data: page.map(toInvoice), next_cursor: rows.length > q.limit ? encodeCursor(page.at(-1)!) : null };
  });

  app.get("/v1/invoices/:id", async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = await loadOwned(req.merchantId!, id);
    const rows = await db.select().from(settlements).where(eq(settlements.invoiceId, id)).orderBy(settlements.createdAt);
    return { ...toInvoice(row), settlements: rows.map(toSettlement) };
  });

  app.post("/v1/invoices/:id/cancel", async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = await loadOwned(req.merchantId!, id);
    const status = effectiveStatus(row);
    if (status !== "pending") throw new HttpError(409, "invalid_state", `Cannot cancel an invoice that is ${status}`);
    // Guard on status so a concurrent payment transition wins over a cancel.
    const [updated] = await db
      .update(invoices)
      .set({ status: "canceled" })
      .where(and(eq(invoices.id, id), eq(invoices.status, "pending")))
      .returning();
    if (!updated) throw new HttpError(409, "invalid_state", "Invoice state changed, refresh and retry");
    const invoice = toInvoice(updated);
    await enqueueWebhook(db, { merchantId: updated.merchantId, invoiceId: id, type: "invoice.canceled", data: invoice });
    return invoice;
  });

  // Re-send the checkout link to the buyer. Throttled so it can't be used to spam.
  app.post("/v1/invoices/:id/resend", async (req) => {
    const { id } = parse(IdParams, req.params);
    const row = await loadOwned(req.merchantId!, id);
    const status = effectiveStatus(row);
    if (status !== "pending") throw new HttpError(409, "invalid_state", `Cannot resend an invoice that is ${status}`);
    if (!row.buyerEmail) throw new HttpError(422, "no_buyer_email", "This invoice has no buyer_email");
    if ((await recentEmails(db, id, "invoice_issued", 10 * 60_000)) > 0) {
      throw new HttpError(429, "resend_throttled", "The invoice was sent in the last 10 minutes");
    }
    if ((await recentEmails(db, id, "invoice_issued", 24 * 3600_000)) >= 5) {
      throw new HttpError(429, "resend_throttled", "At most 5 sends per invoice per day");
    }
    await sendInvoiceEmail(db, row);
    return { sent_to: row.buyerEmail };
  });
}

async function sendInvoiceEmail(db: Db, inv: typeof invoices.$inferSelect) {
  const [m] = await db.select({ name: merchants.businessName }).from(merchants).where(eq(merchants.id, inv.merchantId));
  await enqueueEmail(db, {
    template: "invoice_issued",
    merchantId: inv.merchantId,
    invoiceId: inv.id,
    to: inv.buyerEmail!,
    ...invoiceIssued({ merchantName: m!.name, invoiceNumber: inv.invoiceNumber, amountUsd: inv.amountUsd, checkoutUrl: inv.checkoutUrl, expiresAt: inv.expiresAt }),
  });
}
