import { createHmac, timingSafeEqual } from "node:crypto";
import type { Chain, Token } from "@coinnew/shared-types";

// MoonPay: card on-ramp fallback for buyers without a wallet. The widget URL
// is signed so the destination wallet and amount can't be tampered with.

/** MoonPay currency codes. Verify against GET /v3/currencies before go-live. */
export const MOONPAY_CURRENCY: Partial<Record<`${Chain}:${Token}`, string>> = {
  "ethereum:USDC": "usdc",
  "ethereum:USDT": "usdt",
  "base:USDC": "usdc_base",
  "polygon:USDC": "usdc_polygon",
  "polygon:USDT": "usdt_polygon",
  "solana:USDC": "usdc_sol",
  "solana:USDT": "usdt_sol",
};

export interface MoonPayConfig {
  publishableKey: string;
  /** Signs widget URLs (MoonPay "secret key"). */
  urlSigningSecret: string;
  /** Verifies MoonPay webhooks. */
  webhookKey: string;
  sandbox: boolean;
}

export function signedWidgetUrl(
  cfg: MoonPayConfig,
  args: { currencyCode: string; walletAddress: string; cryptoAmount: string; externalTransactionId: string; redirectUrl: string },
): string {
  const url = new URL(cfg.sandbox ? "https://buy-sandbox.moonpay.com" : "https://buy.moonpay.com");
  url.searchParams.set("apiKey", cfg.publishableKey);
  url.searchParams.set("currencyCode", args.currencyCode);
  url.searchParams.set("walletAddress", args.walletAddress);
  url.searchParams.set("quoteCurrencyAmount", args.cryptoAmount);
  url.searchParams.set("lockAmount", "true");
  url.searchParams.set("showWalletAddressForm", "false");
  url.searchParams.set("externalTransactionId", args.externalTransactionId);
  url.searchParams.set("redirectURL", args.redirectUrl);
  const signature = createHmac("sha256", cfg.urlSigningSecret).update(url.search).digest("base64");
  url.searchParams.set("signature", signature);
  return url.toString();
}

/** `Moonpay-Signature-V2: t=<unix seconds>,s=<hex HMAC-SHA256(webhookKey, "<t>.<body>")>` */
export function verifyMoonPaySignature(header: string | undefined, rawBody: string, webhookKey: string, now = Date.now(), toleranceMs = 10 * 60_000): boolean {
  const m = header && /t=(\d+),s=([0-9a-f]+)/.exec(header);
  if (!m) return false;
  if (Math.abs(now - Number(m[1]) * 1000) > toleranceMs) return false;
  const expected = createHmac("sha256", webhookKey).update(`${m[1]}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2]!);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MoonPayTransaction {
  id: string;
  status: "waitingPayment" | "pending" | "waitingAuthorization" | "completed" | "failed";
  externalTransactionId?: string | null;
  cryptoTransactionId?: string | null;
  walletAddress?: string;
  quoteCurrencyAmount?: number | null;
  failureReason?: string | null;
}
