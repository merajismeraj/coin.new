import { invoices, merchants, type Db } from "@coinnew/db";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import { toCheckoutInvoice } from "../lib/serialize.js";

/** Public, unauthenticated: only what the hosted checkout page needs to render. */
export async function checkoutRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get("/v1/checkout/:invoice_id", async (req) => {
    const parsed = z.object({ invoice_id: z.string().uuid() }).safeParse(req.params);
    const notFound = new HttpError(404, "not_found", "Invoice not found");
    if (!parsed.success) throw notFound;
    const [row] = await db
      .select({ invoice: invoices, merchantName: merchants.businessName })
      .from(invoices)
      .innerJoin(merchants, eq(merchants.id, invoices.merchantId))
      .where(eq(invoices.id, parsed.data.invoice_id));
    if (!row) throw notFound;
    return toCheckoutInvoice(row.invoice, row.merchantName);
  });
}
