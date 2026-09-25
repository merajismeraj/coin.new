import { chainInfo, formatUnits, sameAddress, supportedPairs, tokenInfo, usdToUnits, type Network } from "@coinnew/chains";
import type { ChainVerifier } from "@coinnew/chains/verify";
import { invoices, liquidationAddresses, merchants, partnerAccounts, partnerEvents, partnerSessions, settlements, type Db } from "@coinnew/db";
import type { z } from "zod";
import {
  chainFamily,
  type BankAccountBody,
  type BankInstructions,
  type Chain,
  type FiatMethod,
  type FiatSession,
  type PartnerStatus,
  type Token,
} from "@coinnew/shared-types";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { BRIDGE_CRYPTO_RAILS, BridgeError, type BridgeApi, type ExternalAccountInput, type Transfer } from "../rails/bridge.js";
import { MOONPAY_CURRENCY, signedWidgetUrl, type MoonPayTransaction } from "../rails/moonpay.js";
import { onConfirmed } from "./payments.js";
import { claimDue } from "../lib/claim.js";
import type { WalletScreener } from "./screening.js";

export interface PartnerDeps {
  db: Db;
  config: Config;
  bridge: BridgeApi | null;
  verifier: ChainVerifier;
  screener: WalletScreener;
  log?: { warn: (o: object, msg: string) => void };
}

type MerchantRow = typeof merchants.$inferSelect;
type InvoiceRow = typeof invoices.$inferSelect;
type AccountRow = typeof partnerAccounts.$inferSelect;

const FINAL_KYC = new Set(["approved", "rejected", "offboarded"]);
const requireBridge = (d: PartnerDeps) => {
  if (!d.bridge) throw new HttpError(503, "partner_unavailable", "Fiat rails are not configured");
  return d.bridge;
};
const partnerError = (e: unknown): never => {
  if (e instanceof BridgeError) throw new HttpError(502, "partner_error", `Partner rejected the request (${e.status})`, e.status < 500 ? e.body : undefined);
  throw e;
};
const isPayoutReady = (a: AccountRow | undefined) => !!a && a.kycStatus === "approved" && a.tosStatus === "approved" && !!a.externalAccountId;

// ---- Merchant onboarding & payout ------------------------------------------

const REFRESH_EVERY_MS = 60_000;

/**
 * The merchant's partner account. While the KYB decision isn't final, pulls
 * the latest from Bridge (at most once a minute; kyc_link webhooks also keep it fresh).
 */
async function loadAccount(d: PartnerDeps, merchantId: string) {
  const [a] = await d.db.select().from(partnerAccounts).where(eq(partnerAccounts.merchantId, merchantId));
  const settled = a && FINAL_KYC.has(a.kycStatus) && a.tosStatus === "approved";
  if (!a?.kycLinkId || !d.bridge || settled || Date.now() - a.updatedAt.getTime() < REFRESH_EVERY_MS) return a;
  const link = await d.bridge.getKycLink(a.kycLinkId).catch(() => null);
  if (!link) return a;
  return saveKyc(d.db, merchantId, link.kyc_status, link.tos_status, link.customer_id);
}

export async function getPartnerStatus(d: PartnerDeps, merchantId: string): Promise<PartnerStatus> {
  const a = await loadAccount(d, merchantId);
  const liq = await d.db.select().from(liquidationAddresses).where(eq(liquidationAddresses.merchantId, merchantId));
  return {
    rail: "bridge",
    kyc_status: a?.kycStatus ?? "not_started",
    tos_status: a?.tosStatus ?? "pending",
    kyc_link_url: a?.kycLinkUrl ?? null,
    tos_link_url: a?.tosLinkUrl ?? null,
    bank_account: a?.externalAccountId ? { last4: a.externalAccountLast4!, rail: a.externalAccountRail!, currency: a.externalAccountCurrency! } : null,
    payout_ready: isPayoutReady(a),
    liquidation_addresses: liq
      .filter((l) => l.externalAccountId === a?.externalAccountId)
      .map((l) => ({ chain: l.chain as Chain, token: l.token as Token, address: l.address })),
  };
}

async function saveKyc(db: Db, merchantId: string, kycStatus: string, tosStatus: string, customerId: string | null) {
  const [a] = await db
    .update(partnerAccounts)
    .set({ kycStatus, tosStatus, ...(customerId && { customerId }), updatedAt: new Date() })
    .where(eq(partnerAccounts.merchantId, merchantId))
    .returning();
  if (customerId) await db.update(merchants).set({ partnerRailCustomerId: customerId }).where(eq(merchants.id, merchantId));
  return a!;
}

/** Starts (or resumes) KYB at Bridge. Returns hosted links; coin.new never sees documents. */
export async function startOnboarding(d: PartnerDeps, m: MerchantRow, redirectUri?: string): Promise<PartnerStatus> {
  const bridge = requireBridge(d);
  const existing = await loadAccount(d, m.id);
  if (!existing?.kycLinkId) {
    const link = await bridge.createKycLink({ full_name: m.businessName, email: m.email, type: "business", ...(redirectUri && { redirect_uri: redirectUri }) }).catch(partnerError);
    await d.db
      .insert(partnerAccounts)
      .values({ merchantId: m.id, kycLinkId: link.id, kycLinkUrl: link.kyc_link, tosLinkUrl: link.tos_link, kycStatus: link.kyc_status, tosStatus: link.tos_status, customerId: link.customer_id })
      .onConflictDoUpdate({
        target: partnerAccounts.merchantId,
        set: { kycLinkId: link.id, kycLinkUrl: link.kyc_link, tosLinkUrl: link.tos_link, kycStatus: link.kyc_status, tosStatus: link.tos_status, customerId: link.customer_id, updatedAt: new Date() },
      });
  }
  return getPartnerStatus(d, m.id);
}

/**
 * Registers the merchant's payout bank account at Bridge. Account numbers pass
 * through to the partner and are not stored here (only an id and last 4).
 */
export async function addBankAccount(d: PartnerDeps, m: MerchantRow, body: z.output<typeof BankAccountBody>): Promise<PartnerStatus> {
  const bridge = requireBridge(d);
  const a = await loadAccount(d, m.id);
  if (!a?.customerId || a.kycStatus !== "approved") throw new HttpError(409, "kyb_required", "Complete business verification before adding a bank account");
  const input: ExternalAccountInput =
    body.account_type === "us"
      ? {
          currency: "usd",
          account_type: "us",
          bank_name: body.bank_name,
          account_owner_name: body.account_owner_name,
          account: { account_number: body.account_number, routing_number: body.routing_number, checking_or_savings: body.checking_or_savings },
          address: body.address,
        }
      : {
          currency: "eur",
          account_type: "iban",
          account_owner_name: body.account_owner_name,
          account_owner_type: "business",
          business_name: m.businessName,
          iban: { account_number: body.iban, bic: body.bic, country: body.country },
        };
  const acct = await bridge.createExternalAccount(a.customerId, input).catch(partnerError);
  await d.db
    .update(partnerAccounts)
    .set({
      externalAccountId: acct.id,
      externalAccountLast4: acct.last_4,
      externalAccountRail: body.account_type === "us" ? body.rail : "sepa",
      externalAccountCurrency: input.currency,
      updatedAt: new Date(),
    })
    .where(eq(partnerAccounts.merchantId, m.id));
  return getPartnerStatus(d, m.id);
}

/**
 * Enabling fiat payout: provisions Bridge liquidation addresses for the
 * merchant's enabled (chain, token) pairs. Stablecoins sent there are converted
 * and paid to the merchant's bank by Bridge. Pairs Bridge rejects are skipped.
 */
export async function enableFiatPayout(d: PartnerDeps, m: MerchantRow): Promise<void> {
  const a = await loadAccount(d, m.id);
  if (!isPayoutReady(a)) throw new HttpError(422, "partner_rail_required", "Fiat payout needs approved business verification and a bank account");
  const bridge = requireBridge(d);
  const existing = await d.db.select().from(liquidationAddresses).where(and(eq(liquidationAddresses.merchantId, m.id), eq(liquidationAddresses.externalAccountId, a!.externalAccountId!)));
  const have = new Set(existing.map((l) => `${l.chain}:${l.token}`));
  const rails = (m.preferredChains as Chain[]).filter((c) => (BRIDGE_CRYPTO_RAILS as readonly Chain[]).includes(c));
  const pairs = supportedPairs(d.config.network, rails, ["USDC", "USDT"]).filter((p) => !have.has(`${p.chain}:${p.token}`));
  for (const p of pairs) {
    try {
      const l = await bridge.createLiquidationAddress(a!.customerId!, {
        chain: p.chain,
        currency: p.token.toLowerCase(),
        external_account_id: a!.externalAccountId!,
        destination_payment_rail: a!.externalAccountRail as "ach" | "wire" | "sepa",
        destination_currency: a!.externalAccountCurrency!,
      });
      await d.db
        .insert(liquidationAddresses)
        .values({ merchantId: m.id, chain: p.chain, token: p.token, address: l.address, externalId: l.id, externalAccountId: a!.externalAccountId! })
        .onConflictDoNothing();
      have.add(`${p.chain}:${p.token}`);
    } catch (e) {
      if (!(e instanceof BridgeError && e.status < 500)) throw e;
      d.log?.warn({ chain: p.chain, token: p.token, status: e.status }, "partner does not support liquidation for pair");
    }
  }
  if (!have.size) throw new HttpError(422, "no_payout_route", "The partner can't pay out any of your enabled chains/tokens to this bank account");
}

/**
 * Where buyers send stablecoins for this merchant. Crypto payout: the
 * merchant's own wallet. Fiat payout: the partner's liquidation address, or
 * null if that pair has none (the option is then not offered).
 */
export async function receivingAddresses(db: Db, m: MerchantRow): Promise<(chain: Chain, token: Token) => string | null> {
  if (m.payoutPreference !== "fiat_via_partner") {
    return (chain) => (chainFamily(chain) === "evm" ? m.evmWallet : m.solanaWallet);
  }
  const [a] = await db.select().from(partnerAccounts).where(eq(partnerAccounts.merchantId, m.id));
  const liq = a?.externalAccountId
    ? await db.select().from(liquidationAddresses).where(and(eq(liquidationAddresses.merchantId, m.id), eq(liquidationAddresses.externalAccountId, a.externalAccountId)))
    : [];
  return (chain, token) => liq.find((l) => l.chain === chain && l.token === token)?.address ?? null;
}

// ---- Buyer fiat sessions -----------------------------------------------------

export async function fiatMethods(d: PartnerDeps, m: MerchantRow, inv: InvoiceRow, cardOptions: { chain: Chain; token: Token }[]): Promise<FiatMethod[]> {
  const out: FiatMethod[] = [];
  const a = await loadAccount(d, m.id);
  if (d.bridge && a?.customerId && a.kycStatus === "approved" && a.tosStatus === "approved" && bankDestination(m, a, inv)) out.push("bank_transfer");
  if (d.config.moonpay && cardOptions.some((o) => MOONPAY_CURRENCY[`${o.chain}:${o.token}`])) out.push("card");
  return out;
}

/** Bridge transfer destination: the merchant's wallet (crypto payout) or bank (fiat payout). */
function bankDestination(m: MerchantRow, a: AccountRow, inv: InvoiceRow) {
  if (m.payoutPreference === "fiat_via_partner" && a.externalAccountId) {
    return { payment_rail: a.externalAccountRail as "ach" | "wire" | "sepa", currency: a.externalAccountCurrency as "usd" | "eur", external_account_id: a.externalAccountId };
  }
  const chain = BRIDGE_CRYPTO_RAILS.find((c) => (inv.acceptedChains as Chain[]).includes(c) && (chainFamily(c) === "evm" ? m.evmWallet : m.solanaWallet));
  if (!chain) return null;
  return { payment_rail: chain, currency: "usdc" as const, to_address: (chainFamily(chain) === "evm" ? m.evmWallet : m.solanaWallet)! };
}

const toInstructions = (t: Transfer): BankInstructions | null => {
  const i = t.source_deposit_instructions;
  if (!i) return null;
  return {
    rail: i.payment_rail,
    amount: i.amount,
    currency: i.currency,
    reference: i.deposit_message,
    bank_name: i.bank_name ?? null,
    bank_address: i.bank_address ?? null,
    beneficiary_name: i.bank_beneficiary_name ?? i.account_holder_name ?? null,
    beneficiary_address: i.bank_beneficiary_address ?? null,
    routing_number: i.bank_routing_number ?? null,
    account_number: i.bank_account_number ?? null,
    iban: i.iban ?? null,
    bic: i.bic ?? null,
  };
};

export const toFiatSession = (s: typeof partnerSessions.$inferSelect, redirectUrl: string | null = null): FiatSession => ({
  id: s.id,
  method: s.method as FiatMethod,
  rail: s.rail as FiatSession["rail"],
  status: s.status as FiatSession["status"],
  instructions: (s.instructions as BankInstructions | null) ?? null,
  redirect_url: redirectUrl,
});

/**
 * Bank transfer via Bridge: one Bridge transfer per invoice, on behalf of the
 * merchant (Bridge's KYB'd customer). The buyer wires funds to Bridge with a
 * unique reference; Bridge settles to the merchant's wallet or bank.
 */
export async function createBankTransferSession(d: PartnerDeps, m: MerchantRow, inv: InvoiceRow, rail: "ach" | "wire"): Promise<FiatSession> {
  const bridge = requireBridge(d);
  const [open] = await d.db
    .select()
    .from(partnerSessions)
    .where(and(eq(partnerSessions.invoiceId, inv.id), eq(partnerSessions.method, "bank_transfer"), inArray(partnerSessions.status, ["open", "processing"])))
    .orderBy(asc(partnerSessions.createdAt))
    .limit(1);
  if (open && (open.instructions as BankInstructions | null)?.rail === (rail === "ach" ? "ach_push" : "wire")) return toFiatSession(open);

  const a = await loadAccount(d, m.id);
  const destination = a && bankDestination(m, a, inv);
  if (!a?.customerId || !destination) throw new HttpError(422, "option_unavailable", "Bank transfer is not available for this invoice");

  const [session] = await d.db.insert(partnerSessions).values({ invoiceId: inv.id, rail: "bridge", method: "bank_transfer" }).returning();
  try {
    const t = await bridge.createTransfer(
      {
        amount: inv.amountUsd,
        on_behalf_of: a.customerId,
        client_reference_id: session!.id,
        source: { payment_rail: rail === "ach" ? "ach_push" : "wire", currency: "usd" },
        destination,
      },
      session!.id,
    );
    const [s] = await d.db
      .update(partnerSessions)
      .set({ externalId: t.id, instructions: toInstructions(t), updatedAt: new Date() })
      .where(eq(partnerSessions.id, session!.id))
      .returning();
    return toFiatSession(s!);
  } catch (e) {
    await d.db.update(partnerSessions).set({ status: "failed", updatedAt: new Date() }).where(eq(partnerSessions.id, session!.id));
    return partnerError(e);
  }
}

/** Card via MoonPay: a signed widget URL that delivers the exact amount to the merchant's receiving address. */
export async function createCardSession(d: PartnerDeps, m: MerchantRow, inv: InvoiceRow, chain: Chain, token: Token): Promise<FiatSession> {
  const mp = d.config.moonpay;
  const code = MOONPAY_CURRENCY[`${chain}:${token}`];
  const t = tokenInfo(d.config.network, chain, token);
  const to = (await receivingAddresses(d.db, m))(chain, token);
  if (!mp || !code || !t || !to || !(inv.acceptedChains as Chain[]).includes(chain) || !(inv.acceptedTokens as Token[]).includes(token)) {
    throw new HttpError(422, "option_unavailable", `Card payment in ${token} on ${chain} is not available for this invoice`);
  }
  const units = usdToUnits(inv.amountUsd, t.decimals);
  const [s] = await d.db
    .insert(partnerSessions)
    .values({ invoiceId: inv.id, rail: "moonpay", method: "card", chain, token, toAddress: to, amountUnits: units.toString() })
    .returning();
  const url = signedWidgetUrl(mp, {
    currencyCode: code,
    walletAddress: to,
    cryptoAmount: formatUnits(units, t.decimals),
    externalTransactionId: s!.id,
    redirectUrl: inv.checkoutUrl,
  });
  return toFiatSession(s!, url);
}

// ---- Partner events (webhooks) -----------------------------------------------

async function settlePartner(
  d: PartnerDeps,
  s: typeof partnerSessions.$inferSelect,
  v: { rail: "bridge" | "moonpay"; chain: Chain | null; txHash: string | null; token: string; amount: string; from: string | null; to: string; raw: unknown; riskFlags?: string[] },
) {
  const [row] = await d.db
    .insert(settlements)
    .values({
      invoiceId: s.invoiceId,
      partnerSessionId: s.id,
      rail: v.rail,
      chain: v.chain,
      txHash: v.txHash,
      token: v.token,
      amount: v.amount,
      fromAddress: v.from,
      toAddress: v.to,
      confirmedAt: new Date(),
      riskFlags: v.riskFlags ?? [],
      rawEvent: v.raw as object,
    })
    .onConflictDoNothing()
    .returning();
  await d.db.update(partnerSessions).set({ status: "completed", updatedAt: new Date() }).where(eq(partnerSessions.id, s.id));
  if (row) await onConfirmed(d.db, row, { network: d.config.network, dashboardUrl: d.config.email.dashboardUrl });
}

const markProcessing = async (d: PartnerDeps, s: typeof partnerSessions.$inferSelect) => {
  await d.db.update(partnerSessions).set({ status: "processing", updatedAt: new Date() }).where(eq(partnerSessions.id, s.id));
  await d.db.update(invoices).set({ status: "processing" }).where(and(eq(invoices.id, s.invoiceId), inArray(invoices.status, ["pending", "expired"])));
};

const markFailed = async (d: PartnerDeps, s: typeof partnerSessions.$inferSelect) => {
  await d.db.update(partnerSessions).set({ status: "failed", updatedAt: new Date() }).where(eq(partnerSessions.id, s.id));
  await d.db.update(invoices).set({ status: "pending" }).where(and(eq(invoices.id, s.invoiceId), eq(invoices.status, "processing")));
};

/** Bridge transfer events: re-read the transfer from Bridge (the event is only a trigger). */
async function handleBridgeTransfer(d: PartnerDeps, transferId: string, raw: unknown) {
  const t = await requireBridge(d).getTransfer(transferId);
  const [s] = await d.db.select().from(partnerSessions).where(and(eq(partnerSessions.rail, "bridge"), eq(partnerSessions.externalId, t.id)));
  if (!s || s.status === "completed") return;
  switch (t.state) {
    case "funds_received":
    case "payment_submitted":
    case "in_review":
      return markProcessing(d, s);
    case "payment_processed": {
      const dest = t.destination;
      const crypto = !dest.external_account_id;
      return settlePartner(d, s, {
        rail: "bridge",
        chain: crypto ? (dest.payment_rail as Chain) : null,
        txHash: t.receipt?.destination_tx_hash ?? null,
        token: crypto ? "USDC" : dest.currency.toUpperCase(),
        amount: t.receipt?.final_amount ?? t.amount,
        from: null,
        to: dest.to_address ?? dest.external_account_id!,
        raw: { partner_event: raw, verified_transfer: t },
      });
    }
    case "canceled":
    case "error":
    case "returned":
    case "refunded":
    case "undeliverable":
      return markFailed(d, s);
    default:
      return; // awaiting_funds
  }
}

/** MoonPay completions are verified on-chain: the delivered transfer must reach the session's address in full. */
async function handleMoonPay(d: PartnerDeps, tx: MoonPayTransaction, raw: unknown): Promise<"retry" | void> {
  if (!tx.externalTransactionId) return;
  const [s] = await d.db.select().from(partnerSessions).where(and(eq(partnerSessions.rail, "moonpay"), eq(partnerSessions.id, tx.externalTransactionId)));
  if (!s || s.status === "completed") return;
  if (!s.externalId) await d.db.update(partnerSessions).set({ externalId: tx.id }).where(eq(partnerSessions.id, s.id));
  if (tx.status === "failed") return markFailed(d, s);
  if (tx.status !== "completed") return markProcessing(d, s);
  if (!tx.cryptoTransactionId) return "retry";

  const chain = s.chain as Chain;
  const t = tokenInfo(d.config.network, chain, s.token as Token)!;
  const v = await d.verifier.verify(chain, tx.cryptoTransactionId);
  const family = chainFamily(chain);
  const hit = v.transfers.find(
    (x) => sameAddress(family, x.tokenAddress, t.address) && sameAddress(family, x.to, s.toAddress!) && x.amountUnits >= BigInt(s.amountUnits!),
  );
  if (!v.found || !hit) return "retry";
  if (!v.final) {
    await markProcessing(d, s);
    return "retry";
  }
  await settlePartner(d, s, {
    rail: "moonpay",
    chain,
    txHash: hit.txHash,
    token: s.token!,
    amount: formatUnits(hit.amountUnits, t.decimals),
    from: hit.from,
    to: hit.to,
    raw: { partner_event: raw, verified: { ...hit, amountUnits: hit.amountUnits.toString() } },
  });
}

async function handleBridgeKyc(d: PartnerDeps, obj: { id?: string; customer_id?: string | null; kyc_status?: string; tos_status?: string }) {
  if (!obj.id) return;
  const [a] = await d.db.select().from(partnerAccounts).where(eq(partnerAccounts.kycLinkId, obj.id));
  if (!a) return;
  // Re-read from Bridge rather than trusting the payload.
  const link = await requireBridge(d).getKycLink(obj.id);
  await saveKyc(d.db, a.merchantId, link.kyc_status, link.tos_status, link.customer_id);
}

export async function processPartnerEvents(d: PartnerDeps, limit = 50): Promise<number> {
  const rows = await claimDue(d.db, partnerEvents, limit);
  for (const e of rows) {
    let error: string | null = null;
    try {
      const p = e.payload as any;
      let r: "retry" | void = undefined;
      if (e.source === "bridge") {
        if (p.event_category === "transfer" && p.event_object_id) await handleBridgeTransfer(d, p.event_object_id, p);
        else if (p.event_category === "kyc_link") await handleBridgeKyc(d, p.event_object ?? {});
      } else if (e.source === "moonpay" && p.data) {
        r = await handleMoonPay(d, p.data as MoonPayTransaction, p);
      }
      if (r === "retry") error = "awaiting on-chain delivery";
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    const attempts = e.attempts + 1;
    await d.db
      .update(partnerEvents)
      .set({ attempts, lastError: error, processedAt: !error || attempts >= 60 ? new Date() : null, nextAttemptAt: new Date(Date.now() + Math.min(3_000 * 2 ** attempts, 10 * 60_000)) })
      .where(eq(partnerEvents.id, e.id));
  }
  return rows.length;
}

export const explorer = (network: Network, chain: Chain, tx: string) => chainInfo(network, chain).explorerTx(tx);
