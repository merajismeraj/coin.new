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
    intentTtlMinutes: 30,
  };
}
