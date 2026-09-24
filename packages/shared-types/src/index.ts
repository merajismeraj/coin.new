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

export const EvmAddress = z.string().trim().refine((a) => walletFamily(a) === "evm", "must be an EVM address (0x…)");
export const SolanaAddress = z.string().trim().refine((a) => walletFamily(a) === "solana", "must be a Solana address");

/** One receiving address per chain family; at least one is required. */
export interface ReceivingWallets {
  evm: string | null;
  solana: string | null;
}

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

const ReceivingWalletsInput = z.object({
  evm: EvmAddress.nullable().optional(),
  solana: SolanaAddress.nullable().optional(),
});

export const CreateMerchantBody = z.object({
  business_name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  country_code: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2"),
  receiving_wallets: ReceivingWalletsInput.refine((w) => !!(w.evm || w.solana), "at least one receiving wallet is required"),
  preferred_chains: z.array(Chain).min(1).transform(uniq).optional(),
});
export type CreateMerchantBody = z.input<typeof CreateMerchantBody>;

export const UpdateMerchantBody = z
  .object({
    receiving_wallets: ReceivingWalletsInput,
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
  receiving_wallets: ReceivingWallets;
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
  /** Fiat payments: the buyer's payment method at the partner. */
  method: FiatMethod | null;
  chain: Chain | null;
  tx_hash: string | null;
  token: Token;
  amount: string;
  from_address: string | null;
  to_address: string;
  /** null while awaiting the chain's confirmation depth. */
  confirmed_at: string | null;
  /** e.g. "sanctions_match" when the payer wallet screens positive. Funds are already with the merchant. */
  risk_flags: string[];
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

/** A (chain, token) pair this invoice can be paid with. */
export interface PaymentOption {
  chain: Chain;
  chain_name: string;
  /** EVM chain id; null for Solana. */
  chain_id: number | null;
  token: Token;
  token_address: string;
  decimals: number;
}

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
  payment_options: PaymentOption[];
  /** Fiat ways to pay, via licensed partners. */
  fiat_methods: FiatMethod[];
  /** Present once a payment has been observed. */
  payment: { chain: Chain; tx_hash: string; explorer_url: string; confirmed: boolean } | null;
}

export const PaymentSelection = z.object({ chain: Chain, token: Token });

export const OnchainIntentBody = PaymentSelection.extend({
  payer_address: WalletAddress,
});
export type OnchainIntentBody = z.input<typeof OnchainIntentBody>;

export interface Quote extends PaymentOption {
  to_address: string;
  /** Invoice amount in token units at par (stablecoin = $1). Intents add a sub-cent reference. */
  amount: string;
  amount_units: string;
}

/**
 * Exactly what the buyer must send. `amount_units` includes a unique sub-cent
 * reference that identifies this payment; sending any other amount won't match.
 */
export interface OnchainIntent extends Quote {
  id: string;
  payer_address: string;
  expires_at: string;
}

// ---- Partner rails (Phase 3) -----------------------------------------------

export const FIAT_METHODS = ["bank_transfer", "card"] as const;
export type FiatMethod = (typeof FIAT_METHODS)[number];

export const FiatSessionBody = z.discriminatedUnion("method", [
  z.object({ method: z.literal("bank_transfer"), rail: z.enum(["ach", "wire"]).default("ach") }),
  z.object({ method: z.literal("card"), chain: Chain, token: Token }),
]);
export type FiatSessionBody = z.input<typeof FiatSessionBody>;

/** Where the buyer sends a bank payment. The reference must be included verbatim. */
export interface BankInstructions {
  rail: string;
  amount: string;
  currency: string;
  reference: string;
  bank_name: string | null;
  bank_address: string | null;
  beneficiary_name: string | null;
  beneficiary_address: string | null;
  routing_number: string | null;
  account_number: string | null;
  iban: string | null;
  bic: string | null;
}

export interface FiatSession {
  id: string;
  method: FiatMethod;
  rail: "bridge" | "moonpay";
  status: "open" | "processing" | "completed" | "failed";
  instructions: BankInstructions | null;
  redirect_url: string | null;
}

export const BankAccountBody = z.discriminatedUnion("account_type", [
  z.object({
    account_type: z.literal("us"),
    bank_name: z.string().trim().min(1).max(200),
    account_owner_name: z.string().trim().min(1).max(200),
    account_number: z.string().trim().regex(/^\d{4,17}$/, "4-17 digits"),
    routing_number: z.string().trim().regex(/^\d{9}$/, "9-digit ABA routing number"),
    checking_or_savings: z.enum(["checking", "savings"]).default("checking"),
    rail: z.enum(["ach", "wire"]).default("ach"),
    address: z.object({
      street_line_1: z.string().trim().min(1),
      city: z.string().trim().min(1),
      state: z.string().trim().optional(),
      postal_code: z.string().trim().min(1),
      country: z.string().trim().length(3, "ISO 3166-1 alpha-3, e.g. USA"),
    }),
  }),
  z.object({
    account_type: z.literal("iban"),
    account_owner_name: z.string().trim().min(1).max(200),
    iban: z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, "invalid IBAN"),
    bic: z.string().trim().toUpperCase().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "invalid BIC"),
    country: z.string().trim().length(3, "ISO 3166-1 alpha-3, e.g. DEU"),
  }),
]);
export type BankAccountBody = z.input<typeof BankAccountBody>;

/** Merchant's standing with the licensed partner. KYB is run by the partner, not coin.new. */
export interface PartnerStatus {
  rail: "bridge";
  kyc_status: string;
  tos_status: string;
  kyc_link_url: string | null;
  tos_link_url: string | null;
  bank_account: { last4: string; rail: string; currency: string } | null;
  /** Approved and has a bank account: fiat payout can be enabled. */
  payout_ready: boolean;
  liquidation_addresses: { chain: Chain; token: Token; address: string }[];
}

// ---- Outbound webhooks -----------------------------------------------------

export const WEBHOOK_EVENTS = ["invoice.paid", "invoice.canceled", "invoice.expired", "settlement.confirmed"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEvent<T = unknown> {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: T;
}

// ---- Errors ----------------------------------------------------------------

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}
