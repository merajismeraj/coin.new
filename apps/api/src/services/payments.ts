import { randomInt } from "node:crypto";
import { chainInfo, formatUnits, maxSuffix, sameAddress, tokenByAddress, tokenInfo, usdToUnits, type Network } from "@coinnew/chains";
import type { ChainVerifier, ObservedTransfer } from "@coinnew/chains/verify";
import { inboundEvents, invoices, liquidationAddresses, merchants, paymentIntents, settlements, unmatchedTransfers, type Db } from "@coinnew/db";
import { claimDue } from "../lib/claim.js";
import { enqueueEmail } from "./email.js";
import { paymentReceipt, paymentReceivedMerchant } from "./email-templates.js";
import { chainFamily, riskFlagsOf, type Chain, type Token } from "@coinnew/shared-types";
import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { isUniqueViolation } from "../lib/errors.js";
import { toInvoice, toSettlement } from "../lib/serialize.js";
import type { WalletScreener } from "./screening.js";
import { enqueueWebhook } from "./webhooks.js";

/** Intents keep matching late payments for this long, then free their amount slot. */
export const INTENT_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** An unconfirmed transfer that vanishes for this long is treated as reorged out. */
const REORG_GRACE_MS = 60 * 60 * 1000;

export interface PaymentDeps {
  db: Db;
  verifier: ChainVerifier;
  screener: WalletScreener;
  network: Network;
  /** Base URL for dashboard links in merchant emails. */
  dashboardUrl?: string;
  log?: { warn: (o: object, msg: string) => void };
}

// ---- Intents ---------------------------------------------------------------

/**
 * Reserves a unique amount for this invoice on (chain, token, receiving
 * address): base amount plus a random sub-cent suffix. The partial unique
 * index on open intents guarantees no two open intents share an amount.
 */
export async function createIntent(
  deps: PaymentDeps,
  args: { invoiceId: string; amountUsd: string; chain: Chain; token: Token; toAddress: string; payerAddress: string; ttlMinutes: number },
) {
  const t = tokenInfo(deps.network, args.chain, args.token)!;
  const base = usdToUnits(args.amountUsd, t.decimals);
  const startBlock = await deps.verifier.head(args.chain).catch(() => null);
  const max = Number(maxSuffix(t.decimals));
  for (let attempt = 0; attempt < 12; attempt++) {
    const amountUnits = base + BigInt(randomInt(1, max + 1));
    try {
      const [row] = await deps.db
        .insert(paymentIntents)
        .values({
          invoiceId: args.invoiceId,
          chain: args.chain,
          token: args.token,
          tokenAddress: t.address,
          decimals: t.decimals,
          toAddress: args.toAddress,
          amountUnits: amountUnits.toString(),
          payerAddress: args.payerAddress,
          startBlock: startBlock?.toString() ?? null,
          expiresAt: new Date(Date.now() + args.ttlMinutes * 60_000),
        })
        .returning();
      return row!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("could not allocate a unique payment amount");
}

// ---- Matching --------------------------------------------------------------

export type ProcessResult = { status: "not_found" } | { status: "processed"; matched: number; confirmed: number };

/**
 * Verifies a transaction against the chain and settles any transfer that
 * matches an open intent. Safe to call repeatedly for the same tx (webhook
 * retries, rechecks, the fallback scanner): settlements are unique per transfer.
 */
export async function processTransaction(deps: PaymentDeps, chain: Chain, txHash: string, rawEvent: unknown): Promise<ProcessResult> {
  const v = await deps.verifier.verify(chain, txHash);
  if (!v.found) return { status: "not_found" };
  let matched = 0;
  let confirmed = 0;
  for (const t of v.transfers) {
    const r = await settleTransfer(deps, t, v.final, rawEvent);
    if (r === "created" || r === "confirmed") matched++;
    if (r === "confirmed" || (r === "created" && v.final)) confirmed++;
  }
  return { status: "processed", matched, confirmed };
}

const settlementKey = (t: ObservedTransfer) =>
  and(
    eq(settlements.rail, "onchain"),
    eq(settlements.chain, t.chain),
    eq(settlements.txHash, t.txHash),
    t.logIndex === null ? isNull(settlements.logIndex) : eq(settlements.logIndex, t.logIndex),
    eq(settlements.toAddress, t.to),
  );

async function settleTransfer(deps: PaymentDeps, t: ObservedTransfer, final: boolean, rawEvent: unknown): Promise<"created" | "confirmed" | "unchanged" | "no_match"> {
  const { db } = deps;
  const [existing] = await db.select().from(settlements).where(settlementKey(t));
  if (existing) {
    if (existing.confirmedAt || !final) return "unchanged";
    const [s] = await db.update(settlements).set({ confirmedAt: new Date() }).where(and(eq(settlements.id, existing.id), isNull(settlements.confirmedAt))).returning();
    if (s) await onConfirmed(db, s, deps);
    return s ? "confirmed" : "unchanged";
  }

  const family = chainFamily(t.chain);
  const addrEq = (col: typeof paymentIntents.tokenAddress | typeof paymentIntents.toAddress, v: string) =>
    family === "evm" ? sql`lower(${col}) = ${v.toLowerCase()}` : eq(col, v);
  const [intent] = await db
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.status, "open"),
        eq(paymentIntents.chain, t.chain),
        addrEq(paymentIntents.tokenAddress, t.tokenAddress),
        addrEq(paymentIntents.toAddress, t.to),
        eq(paymentIntents.amountUnits, t.amountUnits.toString()),
      ),
    );
  if (!intent) {
    await recordUnmatched(deps, t);
    return "no_match";
  }

  const screening = t.from ? await deps.screener.screen(t.chain, t.from) : { blocked: false, flags: [] };
  if (screening.blocked) deps.log?.warn({ chain: t.chain, tx: t.txHash, from: t.from }, "payment received from a screened wallet");

  const created = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(settlements)
      .values({
        invoiceId: intent.invoiceId,
        intentId: intent.id,
        rail: "onchain",
        chain: t.chain,
        txHash: t.txHash,
        logIndex: t.logIndex,
        token: intent.token,
        amount: formatUnits(t.amountUnits, intent.decimals),
        fromAddress: t.from,
        toAddress: t.to,
        confirmedAt: final ? new Date() : null,
        riskFlags: screening.flags,
        rawEvent: { indexer_event: rawEvent ?? null, verified: { ...t, amountUnits: t.amountUnits.toString(), final } },
      })
      .onConflictDoNothing()
      .returning();
    if (!s) return null;
    await tx.update(paymentIntents).set({ status: "matched" }).where(eq(paymentIntents.id, intent.id));
    // Seen but not yet final: show progress. Canceled invoices stay canceled; the merchant decides on a refund.
    if (!final) await tx.update(invoices).set({ status: "processing" }).where(and(eq(invoices.id, intent.invoiceId), inArray(invoices.status, ["pending", "expired"])));
    return s;
  });
  if (!created) return "unchanged";
  if (final) await onConfirmed(db, created, deps);
  return "created";
}

/** Marks the invoice paid (unless canceled) and notifies the merchant (webhooks + email) and the buyer (receipt). */
export async function onConfirmed(db: Db, s: typeof settlements.$inferSelect, ctx: { network: Network; dashboardUrl?: string }) {
  const [paid] = await db
    .update(invoices)
    .set({ status: "paid" })
    .where(and(eq(invoices.id, s.invoiceId), inArray(invoices.status, ["pending", "processing", "expired"])))
    .returning();
  const [inv] = paid ? [paid] : await db.select().from(invoices).where(eq(invoices.id, s.invoiceId));
  const settlement = toSettlement(s);
  await enqueueWebhook(db, { merchantId: inv!.merchantId, invoiceId: inv!.id, type: "settlement.confirmed", data: { invoice_id: inv!.id, settlement } });
  // Resolve any unmatched-transfer row for the same transaction (e.g. seen before a partner settled it).
  if (s.chain && s.txHash) {
    await db
      .update(unmatchedTransfers)
      .set({ status: "assigned", settlementId: s.id, resolvedAt: new Date() })
      .where(and(eq(unmatchedTransfers.chain, s.chain), eq(unmatchedTransfers.txHash, s.txHash), eq(unmatchedTransfers.status, "open")));
  }
  if (!paid) return;
  await enqueueWebhook(db, { merchantId: paid.merchantId, invoiceId: paid.id, type: "invoice.paid", data: { ...toInvoice(paid), settlements: [settlement] } });

  const [m] = await db.select({ name: merchants.businessName, email: merchants.email }).from(merchants).where(eq(merchants.id, paid.merchantId));
  const c = {
    merchantName: m!.name,
    invoiceNumber: paid.invoiceNumber,
    amountUsd: paid.amountUsd,
    checkoutUrl: paid.checkoutUrl,
    expiresAt: paid.expiresAt,
    paidAmount: settlement.amount,
    token: settlement.token,
    via: settlement.rail === "onchain" ? `${settlement.chain} transfer` : settlement.method === "bank_transfer" ? "bank transfer" : "card",
    txUrl: s.chain && s.txHash && /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.test(s.txHash) ? chainInfo(ctx.network, s.chain as Chain).explorerTx(s.txHash) : null,
  };
  if (paid.buyerEmail) await enqueueEmail(db, { template: "payment_receipt", merchantId: paid.merchantId, invoiceId: paid.id, to: paid.buyerEmail, ...paymentReceipt(c) });
  await enqueueEmail(db, {
    template: "payment_received_merchant",
    merchantId: paid.merchantId,
    invoiceId: paid.id,
    to: m!.email,
    ...paymentReceivedMerchant({ ...c, riskFlags: riskFlagsOf(s.riskFlags), dashboardUrl: `${ctx.dashboardUrl ?? ""}/invoices/${paid.id}` }),
  });
}

/**
 * A transfer reached an address we watch for a merchant but matched no intent
 * (wrong amount, fee deducted by an exchange, paid without checkout). Keep it
 * for manual reconciliation instead of silently dropping it.
 */
async function recordUnmatched(deps: PaymentDeps, t: ObservedTransfer) {
  const token = tokenByAddress(deps.network, t.chain, t.tokenAddress);
  if (!token) return; // not a supported stablecoin
  const family = chainFamily(t.chain);
  const addr = family === "evm" ? t.to.toLowerCase() : t.to;
  const [owner] = await deps.db
    .select({ id: merchants.id })
    .from(merchants)
    .where(family === "evm" ? sql`lower(${merchants.evmWallet}) = ${addr}` : eq(merchants.solanaWallet, addr))
    .limit(1);
  const [liq] = owner
    ? []
    : await deps.db
        .select({ id: liquidationAddresses.merchantId })
        .from(liquidationAddresses)
        .where(and(eq(liquidationAddresses.chain, t.chain), family === "evm" ? sql`lower(${liquidationAddresses.address}) = ${addr}` : eq(liquidationAddresses.address, addr)))
        .limit(1);
  const merchantId = owner?.id ?? liq?.id;
  if (!merchantId) return;
  const [settled] = await deps.db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.chain, t.chain), eq(settlements.txHash, t.txHash))).limit(1);
  if (settled) return;
  await deps.db
    .insert(unmatchedTransfers)
    .values({
      merchantId,
      chain: t.chain,
      txHash: t.txHash,
      logIndex: t.logIndex,
      token: token.token,
      tokenAddress: token.address,
      decimals: token.decimals,
      amountUnits: t.amountUnits.toString(),
      fromAddress: t.from,
      toAddress: t.to,
    })
    .onConflictDoNothing();
}

// ---- Background jobs ---------------------------------------------------------

/** Processes stored indexer notifications. RPC lag gets up to 10 attempts with backoff. Safe to run in several workers. */
export async function processInboundEvents(deps: PaymentDeps, limit = 50): Promise<number> {
  const rows = await claimDue(deps.db, inboundEvents, limit);
  for (const e of rows) {
    let error: string | null = null;
    try {
      const r = await processTransaction(deps, e.chain as Chain, e.txHash, { source: e.source, payload: e.payload });
      if (r.status === "not_found") error = "transaction not found on chain";
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    const attempts = e.attempts + 1;
    await deps.db
      .update(inboundEvents)
      .set({ attempts, lastError: error, processedAt: !error || attempts >= 10 ? new Date() : null, nextAttemptAt: new Date(Date.now() + Math.min(2_000 * 2 ** attempts, 5 * 60_000)) })
      .where(eq(inboundEvents.id, e.id));
  }
  return rows.length;
}

/** Re-verifies unconfirmed settlements until final, or reverts them if the tx was reorged out. */
export async function recheckUnconfirmed(deps: PaymentDeps): Promise<void> {
  const rows = await deps.db.select().from(settlements).where(and(eq(settlements.rail, "onchain"), isNull(settlements.confirmedAt)));
  for (const s of rows) {
    const chain = s.chain as Chain;
    const v = await deps.verifier.verify(chain, s.txHash!);
    if (v.found) {
      if (v.final) await processTransaction(deps, chain, s.txHash!, null);
      continue;
    }
    if (Date.now() - s.createdAt.getTime() < REORG_GRACE_MS) continue;
    deps.log?.warn({ chain, tx: s.txHash }, "unconfirmed transfer disappeared; reverting");
    await deps.db.transaction(async (tx) => {
      await tx.delete(settlements).where(eq(settlements.id, s.id));
      if (s.intentId) await tx.update(paymentIntents).set({ status: "open" }).where(eq(paymentIntents.id, s.intentId));
      await tx.update(invoices).set({ status: "pending" }).where(and(eq(invoices.id, s.invoiceId), eq(invoices.status, "processing")));
    });
  }
}

/**
 * Fallback when indexer webhooks are down (spec §5.3): scan each receiving
 * address that has open intents for incoming token transfers.
 */
export async function scanOpenIntents(deps: PaymentDeps): Promise<number> {
  const open = await deps.db
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.status, "open"), gt(paymentIntents.createdAt, new Date(Date.now() - INTENT_MATCH_WINDOW_MS))));
  const groups = new Map<string, { chain: Chain; tokenAddress: string; to: string; fromBlock: bigint | null }>();
  for (const i of open) {
    const family = chainFamily(i.chain as Chain);
    const key = `${i.chain}|${family === "evm" ? i.tokenAddress.toLowerCase() : i.tokenAddress}|${family === "evm" ? i.toAddress.toLowerCase() : i.toAddress}`;
    const start = i.startBlock ? BigInt(i.startBlock) : null;
    const g = groups.get(key);
    if (!g) groups.set(key, { chain: i.chain as Chain, tokenAddress: i.tokenAddress, to: i.toAddress, fromBlock: start });
    else if (g.fromBlock !== null && (start === null || start < g.fromBlock)) g.fromBlock = start;
  }
  let processed = 0;
  for (const g of groups.values()) {
    const hashes = await deps.verifier.scan(g.chain, g).catch((e: Error) => {
      deps.log?.warn({ chain: g.chain, err: e.message }, "fallback scan failed");
      return [];
    });
    for (const h of hashes) {
      // Skip what's already handled: settled, or already in the reconciliation inbox.
      // A busy receiving address would otherwise be re-verified over RPC every pass.
      const [known] = await deps.db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.chain, g.chain), eq(settlements.txHash, h))).limit(1);
      if (known) continue;
      const [inbox] = await deps.db.select({ id: unmatchedTransfers.id }).from(unmatchedTransfers).where(and(eq(unmatchedTransfers.chain, g.chain), eq(unmatchedTransfers.txHash, h))).limit(1);
      if (inbox) continue;
      await processTransaction(deps, g.chain, h, { source: "fallback_scan" });
      processed++;
    }
  }
  return processed;
}

/** Frees amount slots of intents past the late-payment window. */
export async function closeStaleIntents(db: Db): Promise<void> {
  await db
    .update(paymentIntents)
    .set({ status: "closed" })
    .where(and(eq(paymentIntents.status, "open"), lt(paymentIntents.createdAt, new Date(Date.now() - INTENT_MATCH_WINDOW_MS))));
}

export const explorerUrl = (network: Network, chain: Chain, tx: string) => chainInfo(network, chain).explorerTx(tx);
export { sameAddress };
