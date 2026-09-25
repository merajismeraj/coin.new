import type { Network } from "@coinnew/chains";
import { CHAINS, type Chain } from "@coinnew/shared-types";

export interface Config {
  checkoutBaseUrl: string;
  /** Proxy IPs/CIDRs (e.g. the checkout app) whose X-Forwarded-For is trusted, so rate limits apply per buyer IP. */
  trustedProxies: string[] | "all";
  network: Network;
  rpcUrls: Partial<Record<Chain, string>>;
  rateLimit: { enabled: boolean; readsPerMinute: number; writesPerMinute: number };
  indexers: {
    /** One signing key per Alchemy webhook (they are per-network). Auto-managed webhooks add theirs from the DB. */
    alchemySigningKeys: string[];
    /** Auto-registration of watched addresses (Alchemy Notify). Null when not configured. */
    alchemyNotify: { authToken: string; webhookUrl: string } | null;
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
  email: { resendApiKey: string | null; from: string; dashboardUrl: string };
  /** How long the checkout shows a payment intent as valid. */
  intentTtlMinutes: number;
  /** Bearer secret for /internal/cron/tick (Vercel Cron sends it). The route is off when unset. */
  cronSecret: string | null;
  /**
   * Process indexer and partner webhooks as soon as they're stored, not on the
   * next worker pass. For serverless deployments, where the job runner may fire
   * only every minute (or less often).
   */
  inlineWebhookProcessing: boolean;
}

// Alchemy's per-network hosts; one app key works on every network enabled for the app.
const ALCHEMY_HOSTS: Record<Network, Record<Chain, string>> = {
  mainnet: { ethereum: "eth-mainnet", base: "base-mainnet", polygon: "polygon-mainnet", robinhood: "robinhood-mainnet", solana: "solana-mainnet" },
  testnet: { ethereum: "eth-sepolia", base: "base-sepolia", polygon: "polygon-amoy", robinhood: "robinhood-testnet", solana: "solana-devnet" },
};
export const alchemyRpcUrl = (network: Network, chain: Chain, key: string) => `https://${ALCHEMY_HOSTS[network][chain]}.g.alchemy.com/v2/${encodeURIComponent(key)}`;

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env): Config {
  const network = env.NETWORK === "mainnet" ? "mainnet" : "testnet";
  return {
    checkoutBaseUrl: (env.CHECKOUT_BASE_URL ?? "http://localhost:3001").replace(/\/$/, ""),
    // "*" trusts any proxy: only for platforms whose edge overwrites X-Forwarded-For (e.g. Vercel).
    trustedProxies: env.TRUSTED_PROXIES === "*" ? "all" : list(env.TRUSTED_PROXIES),
    network,
    // Explicit RPC_URL_<CHAIN> wins; otherwise one ALCHEMY_API_KEY covers every chain.
    rpcUrls: Object.fromEntries(
      CHAINS.flatMap((c) => {
        const url = env[`RPC_URL_${c.toUpperCase()}`] || (env.ALCHEMY_API_KEY ? alchemyRpcUrl(network, c, env.ALCHEMY_API_KEY) : undefined);
        return url ? [[c, url]] : [];
      }),
    ),
    rateLimit: { enabled: env.RATE_LIMIT_DISABLED !== "1", readsPerMinute: 1000, writesPerMinute: 100 },
    indexers: {
      alchemySigningKeys: list(env.ALCHEMY_SIGNING_KEYS),
      alchemyNotify:
        env.ALCHEMY_AUTH_TOKEN && env.PUBLIC_API_URL
          ? { authToken: env.ALCHEMY_AUTH_TOKEN, webhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/internal/webhooks/chain-indexer/alchemy` }
          : null,
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
    email: {
      resendApiKey: env.RESEND_API_KEY || null,
      from: env.EMAIL_FROM ?? "coin.new <billing@coin.new>",
      dashboardUrl: (env.DASHBOARD_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    },
    intentTtlMinutes: 30,
    cronSecret: env.CRON_SECRET || null,
    inlineWebhookProcessing: env.INLINE_WEBHOOK_PROCESSING === "1",
  };
}
