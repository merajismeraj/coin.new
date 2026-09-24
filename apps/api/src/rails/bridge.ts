import { createVerify, randomUUID } from "node:crypto";

// Bridge (bridge.xyz, a Stripe company): licensed partner for KYB, fiat
// on-ramp via bank transfer, and fiat off-ramp to the merchant's bank.
// Endpoints and field names follow Bridge's v0 API docs; validate against the
// sandbox (api.sandbox.bridge.xyz) before go-live.

export type KycStatus = "not_started" | "incomplete" | "awaiting_ubo" | "under_review" | "manual_review" | "approved" | "rejected" | "paused" | "offboarded";

export interface KycLink {
  id: string;
  customer_id: string | null;
  kyc_link: string;
  tos_link: string;
  kyc_status: KycStatus;
  tos_status: "pending" | "approved";
}

export type BankRail = "ach" | "wire" | "sepa";

export type ExternalAccountInput =
  | {
      currency: "usd";
      account_type: "us";
      bank_name: string;
      account_owner_name: string;
      account: { account_number: string; routing_number: string; checking_or_savings: "checking" | "savings" };
      address: { street_line_1: string; city: string; state?: string; postal_code: string; country: string };
    }
  | {
      currency: "eur";
      account_type: "iban";
      account_owner_name: string;
      account_owner_type: "business";
      business_name: string;
      iban: { account_number: string; bic: string; country: string };
    };

export interface ExternalAccount {
  id: string;
  last_4: string;
  currency: string;
}

export interface LiquidationAddress {
  id: string;
  chain: string;
  currency: string;
  address: string;
}

export type TransferState =
  | "awaiting_funds"
  | "in_review"
  | "funds_received"
  | "payment_submitted"
  | "payment_processed"
  | "canceled"
  | "error"
  | "returned"
  | "refunded"
  | "undeliverable";

export interface DepositInstructions {
  payment_rail: string;
  amount: string;
  currency: string;
  deposit_message: string;
  bank_name?: string;
  bank_address?: string;
  bank_routing_number?: string;
  bank_account_number?: string;
  bank_beneficiary_name?: string;
  bank_beneficiary_address?: string;
  iban?: string;
  bic?: string;
  account_holder_name?: string;
}

export interface Transfer {
  id: string;
  state: TransferState;
  amount: string;
  currency: string;
  on_behalf_of: string;
  client_reference_id?: string | null;
  source: { payment_rail: string; currency: string };
  destination: { payment_rail: string; currency: string; to_address?: string; external_account_id?: string };
  source_deposit_instructions?: DepositInstructions;
  receipt?: { destination_tx_hash?: string | null; final_amount?: string | null };
}

export interface CreateTransferInput {
  amount: string;
  on_behalf_of: string;
  client_reference_id: string;
  source: { payment_rail: "ach_push" | "wire" | "sepa"; currency: "usd" | "eur" };
  destination:
    | { payment_rail: "ethereum" | "base" | "polygon" | "solana"; currency: "usdc"; to_address: string }
    | { payment_rail: BankRail; currency: "usd" | "eur"; external_account_id: string };
}

/** The subset of Bridge's API coin.new uses. A fake implements it in tests. */
export interface BridgeApi {
  createKycLink(input: { full_name: string; email: string; type: "business"; redirect_uri?: string }): Promise<KycLink>;
  getKycLink(id: string): Promise<KycLink>;
  createExternalAccount(customerId: string, input: ExternalAccountInput): Promise<ExternalAccount>;
  createLiquidationAddress(
    customerId: string,
    input: { chain: string; currency: string; external_account_id: string; destination_payment_rail: BankRail; destination_currency: string },
  ): Promise<LiquidationAddress>;
  createTransfer(input: CreateTransferInput, idempotencyKey: string): Promise<Transfer>;
  getTransfer(id: string): Promise<Transfer>;
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Bridge API ${status}`);
  }
}

export class BridgeClient implements BridgeApi {
  constructor(
    private apiKey: string,
    private baseUrl = "https://api.sandbox.bridge.xyz",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Api-Key": this.apiKey,
        accept: "application/json",
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(method === "POST" && { "Idempotency-Key": idempotencyKey ?? randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new BridgeError(res.status, json);
    return json as T;
  }

  createKycLink(input: Parameters<BridgeApi["createKycLink"]>[0]) {
    return this.req<KycLink>("POST", "/v0/kyc_links", input);
  }
  getKycLink(id: string) {
    return this.req<KycLink>("GET", `/v0/kyc_links/${encodeURIComponent(id)}`);
  }
  createExternalAccount(customerId: string, input: ExternalAccountInput) {
    return this.req<ExternalAccount>("POST", `/v0/customers/${encodeURIComponent(customerId)}/external_accounts`, input);
  }
  createLiquidationAddress(customerId: string, input: Parameters<BridgeApi["createLiquidationAddress"]>[1]) {
    return this.req<LiquidationAddress>("POST", `/v0/customers/${encodeURIComponent(customerId)}/liquidation_addresses`, input);
  }
  createTransfer(input: CreateTransferInput, idempotencyKey: string) {
    return this.req<Transfer>("POST", "/v0/transfers", input, idempotencyKey);
  }
  getTransfer(id: string) {
    return this.req<Transfer>("GET", `/v0/transfers/${encodeURIComponent(id)}`);
  }
}

/**
 * Bridge signs webhooks with RSA-SHA256 over "<timestamp>.<raw body>":
 * `X-Webhook-Signature: t=<ms timestamp>,v0=<base64 signature>`, verified with
 * the endpoint's public key. Stale timestamps are rejected (replay protection).
 */
export function verifyBridgeSignature(header: string | undefined, rawBody: string, publicKeyPem: string, now = Date.now(), toleranceMs = 10 * 60_000): boolean {
  const m = header && /t=(\d+),v0=([A-Za-z0-9+/=]+)/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  const tMs = t < 1e12 ? t * 1000 : t;
  if (Math.abs(now - tMs) > toleranceMs) return false;
  try {
    return createVerify("RSA-SHA256").update(`${m[1]}.${rawBody}`).verify(publicKeyPem, m[2]!, "base64");
  } catch {
    return false;
  }
}

/** Bridge supports USDC on-ramp destinations on these chains. */
export const BRIDGE_CRYPTO_RAILS = ["base", "ethereum", "polygon", "solana"] as const;
