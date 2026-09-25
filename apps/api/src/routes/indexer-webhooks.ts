import { createHmac, timingSafeEqual } from "node:crypto";
import { inboundEvents, type Db } from "@coinnew/db";
import type { Chain } from "@coinnew/shared-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { chainForAlchemyNetwork } from "../indexers/alchemy-notify.js";
import { alchemySigningKeyCache } from "../services/alchemy-sync.js";


const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const rawBody = (req: FastifyRequest) => (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";

/**
 * Internal indexer webhooks (spec §4, not exposed to merchants). Signatures are
 * verified before anything is read; payloads are stored verbatim and only used
 * to learn *which transaction to verify on-chain*. Nothing in them is trusted
 * as proof of payment.
 */
export async function indexerWebhookRoutes(app: FastifyInstance, { db, config, processNow }: { db: Db; config: Config; processNow?: () => Promise<unknown> }) {
  const managedKeys = alchemySigningKeyCache(db);
  const store = async (source: string, chain: Chain, hashes: string[], payload: unknown) => {
    const unique = [...new Set(hashes.filter((h) => typeof h === "string" && h.length > 0 && h.length < 128))];
    if (unique.length) {
      await db
        .insert(inboundEvents)
        .values(unique.map((txHash) => ({ source, chain, txHash, payload: payload as object })))
        .onConflictDoNothing();
      // Stored first, so a failure here only delays the event to the next job pass.
      if (processNow) await processNow().catch((err: unknown) => app.log.error({ source, err }, "inline processing failed; left for the job runner"));
    }
    return { accepted: unique.length };
  };

  const opts = { config: { idempotency: false as const, rateLimit: false as const } };

  app.post("/internal/webhooks/chain-indexer/alchemy", opts, async (req, reply) => {
    const sig = req.headers["x-alchemy-signature"];
    const body = rawBody(req);
    const keys = [...config.indexers.alchemySigningKeys, ...(await managedKeys())];
    const valid = typeof sig === "string" && keys.some((k) => safeEqual(createHmac("sha256", k).update(body, "utf8").digest("hex"), sig));
    if (!valid) {
      req.log.warn({ source: "alchemy" }, "rejected indexer webhook with invalid signature");
      throw new HttpError(401, "invalid_signature", "Invalid signature");
    }
    const payload = req.body as { event?: { network?: string; activity?: { hash?: string; category?: string }[] } };
    const chain = chainForAlchemyNetwork(config.network, payload.event?.network ?? "");
    if (!chain) return reply.code(202).send({ accepted: 0, ignored: "network" });
    const hashes = (payload.event?.activity ?? []).filter((a) => a.category === "token" || a.category === "erc20").map((a) => a.hash ?? "");
    return reply.code(202).send(await store("alchemy", chain, hashes, payload));
  });

  app.post("/internal/webhooks/chain-indexer/helius", opts, async (req, reply) => {
    const auth = req.headers.authorization;
    if (!config.indexers.heliusAuthHeader || typeof auth !== "string" || !safeEqual(auth, config.indexers.heliusAuthHeader)) {
      req.log.warn({ source: "helius" }, "rejected indexer webhook with invalid auth header");
      throw new HttpError(401, "invalid_signature", "Invalid authorization");
    }
    // Enhanced webhooks send `signature`; raw webhooks send `transaction.signatures[0]`.
    const txs = Array.isArray(req.body) ? (req.body as { signature?: string; transaction?: { signatures?: string[] } }[]) : [];
    const hashes = txs.map((t) => t.signature ?? t.transaction?.signatures?.[0] ?? "");
    return reply.code(202).send(await store("helius", "solana", hashes, req.body));
  });
}
