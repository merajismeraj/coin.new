import { z } from "zod";

// ---- Enums -----------------------------------------------------------------

export const CHAINS = ["ethereum", "base", "polygon", "solana"] as const;
export const Chain = z.enum(CHAINS);
export type Chain = z.infer<typeof Chain>;

export const EVM_CHAINS: readonly Chain[] = ["ethereum", "base", "polygon"];
export type ChainFamily = "evm" | "solana";
export const chainFamily = (c: Chain): ChainFamily => (c === "solana" ? "solana" : "evm");

export const TOKENS = ["USDC", "USDT"] as const;
export const Token = z.enum(TOKENS);
export type Token = z.infer<typeof Token>;

export const INVOICE_STATUSES = ["pending", "processing", "paid", "expired", "canceled"] as const;
export const InvoiceStatus = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

// 'fiat_via_partner' is accepted by the schema but gated server-side until a
// licensed partner rail is connected (Phase 3).
export const PayoutPreference = z.enum(["crypto", "fiat_via_partner"]);
export type PayoutPreference = z.infer<typeof PayoutPreference>;

// ---- Primitives ------------------------------------------------------------

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function walletFamily(address: string): ChainFamily | null {
  if (EVM_ADDRESS.test(address)) return "evm";
  if (SOLANA_ADDRESS.test(address)) return "solana";
  return null;
}

/** A merchant-controlled receiving address. coin.new never holds keys for it. */
export const WalletAddress = z
  .string()
  .trim()
  .refine((a) => walletFamily(a) !== null, "must be an EVM (0x…) or Solana (base58) address");

/** USD amount with at most 2 decimals, carried as a string to avoid float drift. */
export const UsdAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,16}(\.\d{1,2})?$/.test(v), "must be a positive amount with at most 2 decimals")
  .refine((v) => Number(v) > 0, "must be greater than 0")
  .transform((v) => Number(v).toFixed(2));

const HttpsUrl = z
  .string()
  .url()
  .refine((u) => {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" || (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1"));
  }, "must be an https URL");

const uniq = <T>(xs: T[]) => [...new Set(xs)];

// ---- Merchants -------------------------------------------------------------

export const CreateMerchantBody = z.object({
  business_name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  country_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2"),
  default_receiving_wallet: WalletAddress,
  preferred_chains: z.array(Chain).min(1).transform(uniq).optional(),
});
export type CreateMerchantBody = z.input<typeof CreateMerchantBody>;

export const UpdateMerchantBody = z
  .object({
    default_receiving_wallet: WalletAddress,
    preferred_chains: z.array(Chain).min(1).transform(uniq),
    webhook_url: HttpsUrl.nullable(),
    payout_preference: PayoutPreference,
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "at least one field is required");
export type UpdateMerchantBody = z.input<typeof UpdateMerchantBody>;

export const CreateApiKeyBody = z.object({ label: z.string().trim().max(100).optional() });

export interface Merchant {
  id: string;
  business_name: string;
  email: string;
  country_code: string;
  default_receiving_wallet: string;
  preferred_chains: Chain[];
  payout_preference: PayoutPreference;
  webhook_url: string | null;
  created_at: string;
}

export interface ApiKeySummary {
  id: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** Returned exactly once, at creation. The plaintext key is never stored. */
export interface IssuedApiKey extends ApiKeySummary {
  key: string;
}

export interface CreateMerchantResponse {
  merchant: Merchant;
  api_key: IssuedApiKey;
}

// ---- Invoices --------------------------------------------------------------

export const CreateInvoiceBody = z.object({
  invoice_number: z.string().trim().min(1).max(64).optional(),
  amount_usd: UsdAmount,
  accepted_tokens: z.array(Token).min(1).transform(uniq).default(["USDC", "USDT"]),
  accepted_chains: z.array(Chain).min(1).transform(uniq).optional(),
  buyer_email: z.string().trim().toLowerCase().email().optional(),
  expires_in_hours: z.number().int().min(1).max(24 * 90).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateInvoiceBody = z.input<typeof CreateInvoiceBody>;

export const ListInvoicesQuery = z.object({
  status: InvoiceStatus.optional(),
  created_from: z.string().datetime({ offset: true }).optional(),
  created_to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type ListInvoicesQuery = z.input<typeof ListInvoicesQuery>;

/** Read-only mirror of an on-chain or partner-rail event. Never a balance. */
export interface Settlement {
  id: string;
  rail: "onchain" | "circle" | "bridge" | "moonpay";
  chain: Chain | null;
  tx_hash: string | null;
  token: Token;
  amount: string;
  from_address: string | null;
  to_address: string;
  confirmed_at: string | null;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  amount_usd: string;
  accepted_tokens: Token[];
  accepted_chains: Chain[];
  buyer_email: string | null;
  buyer_wallet: string | null;
  status: InvoiceStatus;
  checkout_url: string;
  expires_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InvoiceWithSettlements extends Invoice {
  settlements: Settlement[];
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

// ---- Checkout (public) -----------------------------------------------------

/** Deliberately minimal: no merchant email, no buyer PII. */
export interface CheckoutInvoice {
  id: string;
  invoice_number: string;
  merchant_name: string;
  amount_usd: string;
  accepted_tokens: Token[];
  accepted_chains: Chain[];
  status: InvoiceStatus;
  expires_at: string | null;
}

// ---- Errors ----------------------------------------------------------------

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
