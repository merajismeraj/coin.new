import { chainInfo, formatUnits, supportedPairs, usdToUnits, type Network } from "@coinnew/chains";
import { invoices, merchants, paymentIntents, settlements, type Db } from "@coinnew/db";
import {
  chainFamily,
  OnchainIntentBody,
  PaymentSelection,
  walletFamily,
  type Chain,
  type OnchainIntent,
  type PaymentOption,
  type Quote,
  type Token,
} from "@coinnew/shared-types";
import { and, count, desc, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { checksumEvm } from "../lib/address.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { HttpError, parse } from "../lib/errors.js";
import { effectiveStatus, toCheckoutInvoice } from "../lib/serialize.js";
import { createIntent, type PaymentDeps } from "../services/payments.js";
import { createBankTransferSession, createCardSession, fiatMethods, receivingAddresses, type PartnerDeps } from "../services/partners.js";
import { FiatSessionBody } from "@coinnew/shared-types";

const MAX_OPEN_INTENTS_PER_INVOICE = 20;
/** Reuse an existing intent only if the buyer still has this long to pay it. */
const REUSE_MIN_REMAINING_MS = 5 * 60_000;

type InvoiceRow = typeof invoices.$inferSelect;
type MerchantRow = typeof merchants.$inferSelect;

function options(network: Network, inv: InvoiceRow, receiveAt: (c: Chain, t: Token) => string | null): (PaymentOption & { to_address: string })[] {
  return supportedPairs(network, inv.acceptedChains as Chain[], inv.acceptedTokens as Token[]).flatMap((t) => {
    const to = receiveAt(t.chain, t.token);
    if (!to) return [];
    const c = chainInfo(network, t.chain);
    return [{ chain: t.chain, chain_name: c.name, chain_id: c.chainId, token: t.token, token_address: t.address, decimals: t.decimals, to_address: to }];
  });
}

/** Public, unauthenticated: only what the hosted checkout page needs. */
export async function checkoutRoutes(app: FastifyInstance, { db, config, payments, partners }: { db: Db; config: Config; payments: PaymentDeps; partners: PartnerDeps }) {
  const load = async (params: unknown) => {
    const parsed = z.object({ invoice_id: z.string().uuid() }).safeParse(params);
    const notFound = new HttpError(404, "not_found", "Invoice not found");
    if (!parsed.success) throw notFound;
    const [row] = await db
      .select({ invoice: invoices, merchant: merchants })
      .from(invoices)
      .innerJoin(merchants, eq(merchants.id, invoices.merchantId))
      .where(eq(invoices.id, parsed.data.invoice_id));
    if (!row) throw notFound;
    return row;
  };

  const assertPayable = (inv: InvoiceRow) => {
    const status = effectiveStatus(inv);
    if (status !== "pending") throw new HttpError(409, "not_payable", `Invoice is ${status}`);
  };

  const quoteFor = async (inv: InvoiceRow, m: MerchantRow, body: unknown): Promise<Quote> => {
    assertPayable(inv);
    const sel = parse(PaymentSelection, body);
    const opt = options(config.network, inv, await receivingAddresses(db, m)).find((o) => o.chain === sel.chain && o.token === sel.token);
    if (!opt) throw new HttpError(422, "option_unavailable", `${sel.token} on ${sel.chain} is not accepted for this invoice`);
    const units = usdToUnits(inv.amountUsd, opt.decimals);
    return { ...opt, amount: formatUnits(units, opt.decimals), amount_units: units.toString() };
  };

  app.get("/v1/checkout/:invoice_id", async (req) => {
    const { invoice, merchant } = await load(req.params);
    const [s] = await db.select().from(settlements).where(eq(settlements.invoiceId, invoice.id)).orderBy(desc(settlements.createdAt)).limit(1);
    const payment =
      s?.chain && s.txHash
        ? { chain: s.chain as Chain, tx_hash: s.txHash, explorer_url: chainInfo(config.network, s.chain as Chain).explorerTx(s.txHash), confirmed: !!s.confirmedAt }
        : null;
    const opts = options(config.network, invoice, await receivingAddresses(db, merchant));
    return toCheckoutInvoice(invoice, merchant.businessName, {
      // The receiving address is revealed with the intent, not in the listing.
      payment_options: opts.map(({ to_address: _, ...o }) => o),
      fiat_methods: await fiatMethods(partners, merchant, invoice, opts),
      payment,
    });
  });

  // Checkout POSTs are naturally idempotent (intents are reused) and have no merchant scope.
  const noIdem = { config: { idempotency: false as const } };

  app.post("/v1/checkout/:invoice_id/quote", noIdem, async (req) => {
    const { invoice, merchant } = await load(req.params);
    return await quoteFor(invoice, merchant, req.body);
  });

  app.post("/v1/checkout/:invoice_id/onchain-intent", noIdem, async (req, reply) => {
    const { invoice, merchant } = await load(req.params);
    const quote = await quoteFor(invoice, merchant, req.body);
    const body = parse(OnchainIntentBody, req.body);
    if (walletFamily(body.payer_address) !== chainFamily(body.chain)) {
      throw new HttpError(422, "payer_wallet_mismatch", `Connect a ${chainInfo(config.network, body.chain).name} wallet to pay on this chain`);
    }
    const payer = chainFamily(body.chain) === "evm" ? checksumEvm(body.payer_address, "payer_address") : body.payer_address;

    const screening = await payments.screener.screen(body.chain, payer);
    if (screening.blocked) {
      req.log.warn({ invoice: invoice.id, chain: body.chain }, "checkout blocked by wallet screening");
      throw new HttpError(403, "payer_not_permitted", "This wallet can't be used for this payment");
    }

    const toResponse = (i: typeof paymentIntents.$inferSelect): OnchainIntent => ({
      ...quote,
      id: i.id,
      to_address: i.toAddress,
      amount: formatUnits(BigInt(i.amountUnits), i.decimals),
      amount_units: i.amountUnits,
      payer_address: i.payerAddress!,
      expires_at: i.expiresAt.toISOString(),
    });

    const open = and(eq(paymentIntents.invoiceId, invoice.id), eq(paymentIntents.status, "open"));
    const [reusable] = await db
      .select()
      .from(paymentIntents)
      .where(
        and(
          open,
          eq(paymentIntents.chain, body.chain),
          eq(paymentIntents.token, body.token),
          eq(paymentIntents.payerAddress, payer),
          eq(paymentIntents.toAddress, quote.to_address),
          gt(paymentIntents.expiresAt, new Date(Date.now() + REUSE_MIN_REMAINING_MS)),
        ),
      )
      .limit(1);
    if (reusable) return toResponse(reusable);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(paymentIntents).where(open);
    if (n >= MAX_OPEN_INTENTS_PER_INVOICE) throw new HttpError(429, "too_many_intents", "Too many payment attempts for this invoice");

    const intent = await createIntent(payments, {
      invoiceId: invoice.id,
      amountUsd: invoice.amountUsd,
      chain: body.chain,
      token: body.token,
      toAddress: quote.to_address,
      payerAddress: payer,
      ttlMinutes: config.intentTtlMinutes,
    });
    await db.update(invoices).set({ buyerWallet: payer }).where(eq(invoices.id, invoice.id));
    return reply.code(201).send(toResponse(intent));
  });

  // Fiat via licensed partners: bank transfer (Bridge) or card (MoonPay).
  app.post("/v1/checkout/:invoice_id/fiat-session", noIdem, async (req, reply) => {
    const { invoice, merchant } = await load(req.params);
    assertPayable(invoice);
    const body = parse(FiatSessionBody, req.body);
    const session =
      body.method === "bank_transfer"
        ? await createBankTransferSession(partners, merchant, invoice, body.rail)
        : await createCardSession(partners, merchant, invoice, body.chain, body.token);
    return reply.code(201).send(session);
  });
}
