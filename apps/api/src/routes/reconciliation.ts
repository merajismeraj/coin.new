import { chainInfo, formatUnits, type Network } from "@coinnew/chains";
import { invoices, settlements, unmatchedTransfers, type Db } from "@coinnew/db";
import {
  AssignTransferBody,
  ExportQuery,
  ListSettlementsQuery,
  type Chain,
  type Page,
  type SettlementListItem,
  type Token,
  type UnmatchedTransfer,
} from "@coinnew/shared-types";
import { and, asc, desc, eq, gte, lt, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { csvRow } from "../lib/csv.js";
import { HttpError, parse } from "../lib/errors.js";
import { effectiveStatus, toSettlement } from "../lib/serialize.js";
import { requireMerchant } from "../plugins/auth.js";
import { onConfirmed, type PaymentDeps } from "../services/payments.js";

const MAX_EXPORT_DAYS = 366;
const MAX_EXPORT_ROWS = 100_000;

type UnmatchedRow = typeof unmatchedTransfers.$inferSelect;
const toUnmatched = (network: Network, u: UnmatchedRow): UnmatchedTransfer => ({
  id: u.id,
  chain: u.chain as Chain,
  tx_hash: u.txHash,
  token: u.token as Token,
  amount: formatUnits(BigInt(u.amountUnits), u.decimals),
  from_address: u.fromAddress,
  to_address: u.toAddress,
  status: u.status as UnmatchedTransfer["status"],
  observed_at: u.observedAt.toISOString(),
  explorer_url: chainInfo(network, u.chain as Chain).explorerTx(u.txHash),
});

/** Spec §4 "Reconciliation & Reporting" plus manual reconciliation of unmatched transfers. */
export async function reconciliationRoutes(app: FastifyInstance, { db, payments }: { db: Db; payments: PaymentDeps }) {
  app.addHook("onRequest", requireMerchant(db));

  // Settlements are merchant-scoped through their invoice.
  const owned = (merchantId: string) => eq(invoices.merchantId, merchantId);

  app.get("/v1/settlements", async (req): Promise<Page<SettlementListItem>> => {
    const q = parse(ListSettlementsQuery, req.query);
    const where: SQL[] = [owned(req.merchantId!)];
    if (q.invoice_id) where.push(eq(settlements.invoiceId, q.invoice_id));
    if (q.rail) where.push(eq(settlements.rail, q.rail));
    if (q.from) where.push(gte(settlements.createdAt, new Date(q.from)));
    if (q.to) where.push(lt(settlements.createdAt, new Date(q.to)));
    if (q.cursor) {
      const [ts, id] = Buffer.from(q.cursor, "base64url").toString().split("|");
      const at = new Date(ts ?? "");
      if (!id || Number.isNaN(at.getTime())) throw new HttpError(400, "invalid_cursor", "Invalid cursor");
      where.push(or(lt(settlements.createdAt, at), and(eq(settlements.createdAt, at), lt(settlements.id, id)))!);
    }
    const rows = await db
      .select({ s: settlements, number: invoices.invoiceNumber, amountUsd: invoices.amountUsd })
      .from(settlements)
      .innerJoin(invoices, eq(invoices.id, settlements.invoiceId))
      .where(and(...where))
      .orderBy(desc(settlements.createdAt), desc(settlements.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      data: page.map((r) => ({
        ...toSettlement(r.s),
        invoice_id: r.s.invoiceId,
        invoice_number: r.number,
        invoice_amount_usd: r.amountUsd,
        created_at: r.s.createdAt.toISOString(),
      })),
      next_cursor: rows.length > q.limit && last ? Buffer.from(`${last.s.createdAt.toISOString()}|${last.s.id}`).toString("base64url") : null,
    };
  });

  // Accountant-ready export of confirmed settlements in [from, to).
  app.get("/v1/reports/export", async (req, reply) => {
    const q = parse(ExportQuery, req.query);
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw new HttpError(400, "invalid_range", "`to` must be after `from`");
    if (to.getTime() - from.getTime() > MAX_EXPORT_DAYS * 86_400_000) throw new HttpError(400, "range_too_large", `Export at most ${MAX_EXPORT_DAYS} days at a time`);

    const rows = await db
      .select({ s: settlements, inv: invoices })
      .from(settlements)
      .innerJoin(invoices, eq(invoices.id, settlements.invoiceId))
      .where(and(owned(req.merchantId!), gte(settlements.confirmedAt, from), lt(settlements.confirmedAt, to)))
      .orderBy(asc(settlements.confirmedAt), asc(settlements.id))
      .limit(MAX_EXPORT_ROWS + 1);
    if (rows.length > MAX_EXPORT_ROWS) throw new HttpError(400, "range_too_large", `More than ${MAX_EXPORT_ROWS} rows; narrow the date range`);

    let csv = csvRow([
      "confirmed_at", "invoice_number", "invoice_id", "invoice_amount_usd", "invoice_status", "buyer_email",
      "rail", "method", "chain", "token", "amount", "tx_hash", "from_address", "to_address", "risk_flags", "settlement_id", "metadata",
    ]);
    for (const { s, inv } of rows) {
      const st = toSettlement(s);
      csv += csvRow([
        st.confirmed_at, inv.invoiceNumber, inv.id, inv.amountUsd, effectiveStatus(inv), inv.buyerEmail,
        st.rail, st.method, st.chain, st.token, st.amount, st.tx_hash, st.from_address, st.to_address, st.risk_flags.join(";"), st.id, inv.metadata,
      ]);
    }
    const name = `coinnew-settlements-${q.from.slice(0, 10)}-to-${q.to.slice(0, 10)}.csv`;
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${name}"`)
      .header("cache-control", "no-store")
      .send(csv);
  });

  // ---- Unmatched transfers -------------------------------------------------

  const loadUnmatched = async (merchantId: string, id: string) => {
    const [u] = await db.select().from(unmatchedTransfers).where(and(eq(unmatchedTransfers.id, id), eq(unmatchedTransfers.merchantId, merchantId)));
    if (!u) throw new HttpError(404, "not_found", "Transfer not found");
    if (u.status !== "open") throw new HttpError(409, "invalid_state", `Transfer is already ${u.status}`);
    return u;
  };
  const IdParams = z.object({ id: z.string().uuid() });

  app.get("/v1/unmatched-transfers", async (req) => {
    const { status } = parse(z.object({ status: z.enum(["open", "assigned", "dismissed"]).default("open") }), req.query);
    const rows = await db
      .select()
      .from(unmatchedTransfers)
      .where(and(eq(unmatchedTransfers.merchantId, req.merchantId!), eq(unmatchedTransfers.status, status)))
      .orderBy(desc(unmatchedTransfers.observedAt))
      .limit(200);
    return { data: rows.map((u) => toUnmatched(payments.network, u)) };
  });

  /**
   * Manually settle an invoice with a transfer that didn't auto-match. The
   * transfer is re-verified on-chain (must still exist and be final) before
   * anything is recorded; the settlement carries a `manual_match` flag.
   */
  app.post("/v1/unmatched-transfers/:id/assign", async (req) => {
    const { id } = parse(IdParams, req.params);
    const { invoice_id } = parse(AssignTransferBody, req.body);
    const u = await loadUnmatched(req.merchantId!, id);
    const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, invoice_id), eq(invoices.merchantId, req.merchantId!)));
    if (!inv) throw new HttpError(404, "not_found", "Invoice not found");
    if (!["pending", "processing", "expired"].includes(effectiveStatus(inv))) {
      throw new HttpError(409, "invalid_state", `Invoice is ${effectiveStatus(inv)}`);
    }

    const v = await payments.verifier.verify(u.chain as Chain, u.txHash);
    const still = v.transfers.find((t) => t.to === u.toAddress && t.amountUnits.toString() === u.amountUnits && (t.logIndex ?? null) === (u.logIndex ?? null));
    if (!v.found || !still) throw new HttpError(409, "not_on_chain", "The transfer is no longer visible on-chain");
    if (!v.final) throw new HttpError(409, "not_final", "The transfer isn't final yet; try again shortly");

    const screening = u.fromAddress ? await payments.screener.screen(u.chain as Chain, u.fromAddress) : { flags: [] as string[] };
    const [s] = await db.transaction(async (tx) => {
      const created = await tx
        .insert(settlements)
        .values({
          invoiceId: inv.id,
          rail: "onchain",
          chain: u.chain,
          txHash: u.txHash,
          logIndex: u.logIndex,
          token: u.token,
          amount: formatUnits(BigInt(u.amountUnits), u.decimals),
          fromAddress: u.fromAddress,
          toAddress: u.toAddress,
          confirmedAt: new Date(),
          riskFlags: ["manual_match", ...screening.flags],
          rawEvent: { manual_assignment: { unmatched_transfer_id: u.id, by: "merchant" }, verified: { ...still, amountUnits: still.amountUnits.toString(), final: v.final } },
        })
        .returning();
      await tx.update(unmatchedTransfers).set({ status: "assigned", settlementId: created[0]!.id, resolvedAt: new Date() }).where(eq(unmatchedTransfers.id, u.id));
      return created;
    });
    await onConfirmed(db, s!, payments);
    return { ...toSettlement(s!), invoice_id: inv.id };
  });

  app.post("/v1/unmatched-transfers/:id/dismiss", async (req) => {
    const { id } = parse(IdParams, req.params);
    await loadUnmatched(req.merchantId!, id);
    const [u] = await db.update(unmatchedTransfers).set({ status: "dismissed", resolvedAt: new Date() }).where(eq(unmatchedTransfers.id, id)).returning();
    return toUnmatched(payments.network, u!);
  });
}

