import type { apiKeys, invoices, merchants, settlements } from "@coinnew/db";
import type { ApiKeySummary, Chain, CheckoutInvoice, Invoice, InvoiceStatus, Merchant, PayoutPreference, Settlement, Token } from "@coinnew/shared-types";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Expiry is applied lazily on read until the Phase 4 expiry job exists, so a
 * pending invoice past its expires_at is always reported as expired.
 */
export function effectiveStatus(row: Pick<Row<typeof invoices>, "status" | "expiresAt">, now = new Date()): InvoiceStatus {
  if (row.status === "pending" && row.expiresAt && row.expiresAt <= now) return "expired";
  return row.status as InvoiceStatus;
}

export const toMerchant = (m: Row<typeof merchants>): Merchant => ({
  id: m.id,
  business_name: m.businessName,
  email: m.email,
  country_code: m.countryCode,
  default_receiving_wallet: m.defaultReceivingWallet,
  preferred_chains: m.preferredChains as Chain[],
  payout_preference: m.payoutPreference as PayoutPreference,
  webhook_url: m.webhookUrl,
  created_at: m.createdAt.toISOString(),
});

export const toApiKey = (k: Row<typeof apiKeys>): ApiKeySummary => ({
  id: k.id,
  label: k.label,
  created_at: k.createdAt.toISOString(),
  revoked_at: iso(k.revokedAt),
});

export const toInvoice = (i: Row<typeof invoices>): Invoice => ({
  id: i.id,
  invoice_number: i.invoiceNumber,
  amount_usd: i.amountUsd,
  accepted_tokens: i.acceptedTokens as Token[],
  accepted_chains: i.acceptedChains as Chain[],
  buyer_email: i.buyerEmail,
  buyer_wallet: i.buyerWallet,
  status: effectiveStatus(i),
  checkout_url: i.checkoutUrl,
  expires_at: iso(i.expiresAt),
  metadata: i.metadata,
  created_at: i.createdAt.toISOString(),
});

export const toSettlement = (s: Row<typeof settlements>): Settlement => ({
  id: s.id,
  rail: s.rail as Settlement["rail"],
  chain: s.chain as Chain | null,
  tx_hash: s.txHash,
  token: s.token as Token,
  amount: s.amount,
  from_address: s.fromAddress,
  to_address: s.toAddress,
  confirmed_at: iso(s.confirmedAt),
});

export const toCheckoutInvoice = (i: Row<typeof invoices>, merchantName: string): CheckoutInvoice => ({
  id: i.id,
  invoice_number: i.invoiceNumber,
  merchant_name: merchantName,
  amount_usd: i.amountUsd,
  accepted_tokens: i.acceptedTokens as Token[],
  accepted_chains: i.acceptedChains as Chain[],
  status: effectiveStatus(i),
  expires_at: iso(i.expiresAt),
});
