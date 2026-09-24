import type { Network } from "@coinnew/chains";
import { CHAINS, type Chain } from "@coinnew/shared-types";

export interface Config {
  checkoutBaseUrl: string;
  /** Proxy IPs/CIDRs (e.g. the checkout app) whose X-Forwarded-For is trusted, so rate limits apply per buyer IP. */
  trustedProxies: string[];
  network: Network;
  rpcUrls: Partial<Record<Chain, string>>;
  rateLimit: { enabled: boolean; readsPerMinute: number; writesPerMinute: number };
  indexers: {
    /** One signing key per Alchemy webhook (they are per-network). */
    alchemySigningKeys: string[];
    /** Value Helius sends in the Authorization header. */
    heliusAuthHeader: string | null;
  };
  screening: {
    chainalysisApiKey: string | null;
    denylist: string[];
    /** Block payments when the screening provider is unreachable. */
    failClosed: boolean;
  };
  webhooks: {
    /** Allow merchant webhook URLs that resolve to private/loopback IPs (local dev and tests only). */
    allowPrivateTargets: boolean;
  };
  /** Licensed partner rails; null when not configured. */
  bridge: { apiKey: string; baseUrl: string; webhookPublicKey: string } | null;
  moonpay: { publishableKey: string; urlSigningSecret: string; webhookKey: string; sandbox: boolean } | null;
  /** How long the checkout shows a payment intent as valid. */
  intentTtlMinutes: number;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env): Config {
  const network = env.NETWORK === "mainnet" ? "mainnet" : "testnet";
  return {
    checkoutBaseUrl: (env.CHECKOUT_BASE_URL ?? "http://localhost:3001").replace(/\/$/, ""),
    trustedProxies: list(env.TRUSTED_PROXIES),
    network,
    rpcUrls: Object.fromEntries(CHAINS.flatMap((c) => (env[`RPC_URL_${c.toUpperCase()}`] ? [[c, env[`RPC_URL_${c.toUpperCase()}`]!]] : []))),
    rateLimit: { enabled: env.RATE_LIMIT_DISABLED !== "1", readsPerMinute: 1000, writesPerMinute: 100 },
    indexers: {
      alchemySigningKeys: list(env.ALCHEMY_SIGNING_KEYS),
      heliusAuthHeader: env.HELIUS_AUTH_HEADER || null,
    },
    screening: {
      chainalysisApiKey: env.CHAINALYSIS_API_KEY || null,
      denylist: list(env.SANCTIONS_DENYLIST),
      failClosed: env.SCREENING_FAIL_CLOSED === "1",
    },
    webhooks: { allowPrivateTargets: env.WEBHOOKS_ALLOW_PRIVATE === "1" },
    bridge: env.BRIDGE_API_KEY
      ? {
          apiKey: env.BRIDGE_API_KEY,
          baseUrl: env.BRIDGE_API_URL ?? (network === "mainnet" ? "https://api.bridge.xyz" : "https://api.sandbox.bridge.xyz"),
          webhookPublicKey: (env.BRIDGE_WEBHOOK_PUBLIC_KEY ?? "").replace(/\\n/g, "\n"),
        }
      : null,
    moonpay: env.MOONPAY_PUBLISHABLE_KEY
      ? {
          publishableKey: env.MOONPAY_PUBLISHABLE_KEY,
          urlSigningSecret: env.MOONPAY_SECRET_KEY ?? "",
          webhookKey: env.MOONPAY_WEBHOOK_KEY ?? "",
          sandbox: network !== "mainnet",
        }
      : null,
    intentTtlMinutes: 30,
  };
}
