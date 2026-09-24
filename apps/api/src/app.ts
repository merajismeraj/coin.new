import rateLimit from "@fastify/rate-limit";
import type { Db } from "@coinnew/db";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { Config } from "./config.js";
import { bearerToken, parseApiKey } from "./lib/api-keys.js";
import { HttpError } from "./lib/errors.js";
import { registerIdempotency } from "./plugins/idempotency.js";
import type { ChainVerifier } from "@coinnew/chains/verify";
import { checkoutRoutes } from "./routes/checkout.js";
import { indexerWebhookRoutes } from "./routes/indexer-webhooks.js";
import type { PaymentDeps } from "./services/payments.js";
import type { WalletScreener } from "./services/screening.js";
import type { PartnerDeps } from "./services/partners.js";
import { BridgeClient, type BridgeApi } from "./rails/bridge.js";
import { partnerWebhookRoutes } from "./routes/partner-webhooks.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { merchantRoutes } from "./routes/merchants.js";

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface AppDeps {
  db: Db;
  config: Config;
  verifier: ChainVerifier;
  screener: WalletScreener;
  /** Override the Bridge client (tests); defaults to one built from config. */
  bridge?: BridgeApi | null;
  logger?: FastifyServerOptions["logger"];
}

export const bridgeFromConfig = (config: Config): BridgeApi | null => (config.bridge ? new BridgeClient(config.bridge.apiKey, config.bridge.baseUrl) : null);

export async function buildApp({ db, config, verifier, screener, bridge = bridgeFromConfig(config), logger = true }: AppDeps) {
  const app = Fastify({
    trustProxy: config.trustedProxies.length ? config.trustedProxies : false,
    logger: logger && {
      // Never log API keys (spec §7.1).
      redact: ["req.headers.authorization"],
    },
  });

  // Keep the raw body: inbound webhook signatures are computed over exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    if (body === "") return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400, code: "invalid_json" }), undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string; error?: unknown };
    if (e.statusCode && e.statusCode < 500) {
      // Rate-limit rejections carry a prebuilt body; framework errors (bad JSON, etc.) do not.
      const body = e.error ? { error: e.error } : { error: { code: e.code?.toLowerCase() ?? "bad_request", message: e.message ?? "Bad request" } };
      return reply.code(e.statusCode).send(body);
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Route not found" } }));

  if (config.rateLimit.enabled) {
    // Spec §4: 100/min on writes and 1000/min on reads, per merchant (per IP when unauthenticated).
    await app.register(rateLimit, {
      timeWindow: "1 minute",
      keyGenerator: (req) => {
        const token = bearerToken(req.headers.authorization);
        const who = (token && parseApiKey(token)?.id) || req.ip;
        return `${who}:${WRITE_METHODS.has(req.method) ? "w" : "r"}`;
      },
      max: (req) => (WRITE_METHODS.has(req.method) ? config.rateLimit.writesPerMinute : config.rateLimit.readsPerMinute),
      errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: "rate_limited", message: `Rate limit exceeded, retry in ${ctx.after}` } }),
    });
  }

  registerIdempotency(app, db);

  app.get("/health", async () => ({ ok: true }));
  const partners: PartnerDeps = { db, config, bridge, verifier, screener, log: app.log };
  await app.register(merchantRoutes, { db, partners });
  await app.register(invoiceRoutes, { db, config });
  const payments: PaymentDeps = { db, verifier, screener, network: config.network, log: app.log };
  await app.register(checkoutRoutes, { db, config, payments, partners });
  await app.register(partnerWebhookRoutes, { db, config });
  await app.register(indexerWebhookRoutes, { db, config });
  return app;
}
