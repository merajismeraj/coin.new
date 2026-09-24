import { partnerEvents, type Db } from "@coinnew/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { verifyBridgeSignature } from "../rails/bridge.js";
import { verifyMoonPaySignature } from "../rails/moonpay.js";

const rawBody = (req: FastifyRequest) => (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";

/**
 * Inbound partner webhooks (spec §4, internal). Signatures are verified before
 * the payload is read; payloads are stored verbatim and processed by the
 * worker, which re-reads state from the partner or the chain before acting.
 */
export async function partnerWebhookRoutes(app: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const opts = { config: { idempotency: false as const, rateLimit: false as const } };
  const store = async (source: string, eventId: string, payload: unknown) => {
    await db.insert(partnerEvents).values({ source, eventId, payload: payload as object }).onConflictDoNothing();
  };

  app.post("/internal/webhooks/bridge", opts, async (req, reply) => {
    const key = config.bridge?.webhookPublicKey;
    if (!key || !verifyBridgeSignature(req.headers["x-webhook-signature"] as string | undefined, rawBody(req), key)) {
      req.log.warn({ source: "bridge" }, "rejected partner webhook with invalid signature");
      throw new HttpError(401, "invalid_signature", "Invalid signature");
    }
    const p = req.body as { event_id?: string };
    if (!p?.event_id) throw new HttpError(400, "invalid_event", "Missing event_id");
    await store("bridge", p.event_id, p);
    return reply.code(202).send({ accepted: true });
  });

  app.post("/internal/webhooks/moonpay", opts, async (req, reply) => {
    const key = config.moonpay?.webhookKey;
    if (!key || !verifyMoonPaySignature(req.headers["moonpay-signature-v2"] as string | undefined, rawBody(req), key)) {
      req.log.warn({ source: "moonpay" }, "rejected partner webhook with invalid signature");
      throw new HttpError(401, "invalid_signature", "Invalid signature");
    }
    const p = req.body as { type?: string; data?: { id?: string; status?: string; updatedAt?: string } };
    if (!p?.data?.id) throw new HttpError(400, "invalid_event", "Missing transaction id");
    await store("moonpay", `${p.type}:${p.data.id}:${p.data.status}:${p.data.updatedAt ?? ""}`, p);
    return reply.code(202).send({ accepted: true });
  });
}
