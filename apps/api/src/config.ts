export interface Config {
  checkoutBaseUrl: string;
  rateLimit: { enabled: boolean; readsPerMinute: number; writesPerMinute: number };
}

export function loadConfig(env = process.env): Config {
  return {
    checkoutBaseUrl: (env.CHECKOUT_BASE_URL ?? "http://localhost:3001").replace(/\/$/, ""),
    rateLimit: { enabled: env.RATE_LIMIT_DISABLED !== "1", readsPerMinute: 1000, writesPerMinute: 100 },
  };
}
