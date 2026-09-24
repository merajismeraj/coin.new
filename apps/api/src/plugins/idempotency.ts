import { createHash } from "node:crypto";
import { idempotencyKeys, type Db } from "@coinnew/db";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../lib/errors.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

declare module "fastify" {
  interface FastifyContextConfig {
    /** Skip idempotency handling (e.g. provider webhooks with their own dedupe). */
    idempotency?: false;
    /**
     * Rewrites a response before it is persisted for replay. Routes that return
     * a one-time secret use this so plaintext keys are never stored at rest.
     */
    redactReplay?: (body: any) => unknown;
  }
  interface FastifyRequest {
    idempotency?: { scope: string; key: string };
  }
}

const scopeOf = (req: FastifyRequest) => req.merchantId ?? "public";

/**
 * Spec §4/§7.4: every mutating call requires an Idempotency-Key. A repeat of
 * the same key+request within 24h replays the stored response; the same key
 * with a different request is rejected; a concurrent duplicate gets 409.
 */
export function registerIdempotency(app: FastifyInstance, db: Db) {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING.has(req.method) || req.routeOptions.config.idempotency === false) return;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 255) {
      throw new HttpError(400, "idempotency_key_required", "Idempotency-Key header (8-255 chars) is required on mutating requests");
    }
    const scope = scopeOf(req);
    const requestHash = createHash("sha256")
      .update(`${req.method} ${req.routeOptions.url} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
      .digest("hex");

    await db.delete(idempotencyKeys).where(
      and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), lt(idempotencyKeys.createdAt, new Date(Date.now() - WINDOW_MS))),
    );
    const inserted = await db
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length) {
      req.idempotency = { scope, key };
      return;
    }

    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    if (!existing) throw new HttpError(409, "idempotency_conflict", "Please retry");
    if (existing.requestHash !== requestHash) {
      throw new HttpError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request");
    }
    if (existing.responseStatus == null) {
      throw new HttpError(409, "idempotency_in_progress", "A request with this Idempotency-Key is still being processed");
    }
    return reply
      .code(existing.responseStatus)
      .header("content-type", "application/json; charset=utf-8")
      .header("idempotent-replayed", "true")
      .send(existing.responseBody);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem) return payload;
    const where = and(eq(idempotencyKeys.scope, idem.scope), eq(idempotencyKeys.key, idem.key));
    if (reply.statusCode >= 500) {
      // Let the client retry a server failure with the same key.
      await db.delete(idempotencyKeys).where(where);
      return payload;
    }
    let stored = typeof payload === "string" ? payload : "";
    const redact = req.routeOptions.config.redactReplay;
    if (redact && reply.statusCode < 300 && stored) stored = JSON.stringify(redact(JSON.parse(stored)));
    await db.update(idempotencyKeys).set({ responseStatus: reply.statusCode, responseBody: stored }).where(where);
    return payload;
  });
}
