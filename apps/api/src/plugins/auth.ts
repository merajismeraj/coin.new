import { apiKeys, type Db } from "@coinnew/db";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { bearerToken, parseApiKey, verifyApiKey } from "../lib/api-keys.js";
import { HttpError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    merchantId?: string;
  }
}

/** onRequest hook: resolves `Authorization: Bearer <api key>` to a merchant. */
export function requireMerchant(db: Db) {
  return async (req: FastifyRequest) => {
    const token = bearerToken(req.headers.authorization);
    const parsed = token ? parseApiKey(token) : null;
    if (!parsed) throw new HttpError(401, "unauthorized", "Missing or malformed API key");
    const [row] = await db
      .select({ merchantId: apiKeys.merchantId, keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, parsed.id), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row || !(await verifyApiKey(row.keyHash, parsed.secret))) {
      throw new HttpError(401, "unauthorized", "Invalid or revoked API key");
    }
    req.merchantId = row.merchantId;
  };
}
