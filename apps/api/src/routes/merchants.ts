import { apiKeys, merchants, type Db } from "@coinnew/db";
import {
  chainFamily,
  CreateApiKeyBody,
  CreateMerchantBody,
  EVM_CHAINS,
  UpdateMerchantBody,
  walletFamily,
  type Chain,
  type CreateMerchantResponse,
  type IssuedApiKey,
} from "@coinnew/shared-types";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateApiKey } from "../lib/api-keys.js";
import { HttpError, isUniqueViolation, parse } from "../lib/errors.js";
import { toApiKey, toMerchant } from "../lib/serialize.js";
import { requireMerchant } from "../plugins/auth.js";

const REDACTED = "[redacted: shown once at creation]";

/**
 * A single receiving address can only serve one chain family. Until merchants
 * register per-family addresses (needed before Phase 2 ships Solana), every
 * preferred chain must match the wallet's family.
 */
function resolveChains(wallet: string, requested: Chain[] | undefined): Chain[] {
  const family = walletFamily(wallet)!;
  if (!requested) return family === "evm" ? [...EVM_CHAINS] : ["solana"];
  const mismatched = requested.filter((c) => chainFamily(c) !== family);
  if (mismatched.length) {
    throw new HttpError(422, "chain_wallet_mismatch", `Receiving wallet is a ${family} address and cannot receive on: ${mismatched.join(", ")}`);
  }
  return requested;
}

async function issueKey(db: Db, merchantId: string, label: string | null): Promise<IssuedApiKey> {
  const key = await generateApiKey();
  const [row] = await db.insert(apiKeys).values({ id: key.id, merchantId, keyHash: key.hash, label }).returning();
  return { ...toApiKey(row!), key: key.plaintext };
}

export async function merchantRoutes(app: FastifyInstance, { db }: { db: Db }) {
  // Public onboarding. Returns the first API key exactly once.
  app.post(
    "/v1/merchants",
    { config: { redactReplay: (b: CreateMerchantResponse) => ({ ...b, api_key: { ...b.api_key, key: REDACTED } }) } },
    async (req, reply) => {
      const body = parse(CreateMerchantBody, req.body);
      const preferredChains = resolveChains(body.default_receiving_wallet, body.preferred_chains);
      const result = await db
        .transaction(async (tx) => {
          const [m] = await tx
            .insert(merchants)
            .values({
              businessName: body.business_name,
              email: body.email,
              countryCode: body.country_code,
              defaultReceivingWallet: body.default_receiving_wallet,
              preferredChains,
            })
            .returning();
          return { merchant: toMerchant(m!), api_key: await issueKey(tx as unknown as Db, m!.id, "default") };
        })
        .catch((err) => {
          if (isUniqueViolation(err)) throw new HttpError(409, "merchant_exists", "A merchant with this email already exists");
          throw err;
        });
      return reply.code(201).send(result satisfies CreateMerchantResponse);
    },
  );

  app.register(async (authed) => {
    authed.addHook("onRequest", requireMerchant(db));

    const loadMe = async (id: string) => {
      const [m] = await db.select().from(merchants).where(eq(merchants.id, id));
      if (!m) throw new HttpError(404, "not_found", "Merchant not found");
      return m;
    };

    authed.get("/v1/merchants/me", async (req) => toMerchant(await loadMe(req.merchantId!)));

    authed.patch("/v1/merchants/me", async (req) => {
      const body = parse(UpdateMerchantBody, req.body);
      const current = await loadMe(req.merchantId!);
      const wallet = body.default_receiving_wallet ?? current.defaultReceivingWallet;
      const walletChanged = body.default_receiving_wallet !== undefined && body.default_receiving_wallet !== current.defaultReceivingWallet;
      // Changing wallet family without new chains re-derives the defaults.
      const chains =
        body.preferred_chains ??
        (walletChanged && walletFamily(wallet) !== walletFamily(current.defaultReceivingWallet) ? undefined : (current.preferredChains as Chain[]));
      const preferredChains = resolveChains(wallet, chains);

      if (body.payout_preference === "fiat_via_partner" && !current.partnerRailCustomerId) {
        throw new HttpError(422, "partner_rail_required", "Fiat payout requires onboarding with a licensed partner rail first");
      }
      const [m] = await db
        .update(merchants)
        .set({
          defaultReceivingWallet: wallet,
          preferredChains,
          ...(body.webhook_url !== undefined && { webhookUrl: body.webhook_url }),
          ...(body.payout_preference && { payoutPreference: body.payout_preference }),
        })
        .where(eq(merchants.id, req.merchantId!))
        .returning();
      return toMerchant(m!);
    });

    authed.get("/v1/merchants/me/api-keys", async (req) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.merchantId, req.merchantId!)).orderBy(desc(apiKeys.createdAt));
      return { data: rows.map(toApiKey) };
    });

    authed.post(
      "/v1/merchants/me/api-keys",
      { config: { redactReplay: (b: IssuedApiKey) => ({ ...b, key: REDACTED }) } },
      async (req, reply) => {
        const body = parse(CreateApiKeyBody, req.body ?? {});
        return reply.code(201).send(await issueKey(db, req.merchantId!, body.label ?? null));
      },
    );

    authed.delete("/v1/merchants/me/api-keys/:id", async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const active = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.merchantId, req.merchantId!), isNull(apiKeys.revokedAt)));
      if (!active.some((k) => k.id === id)) throw new HttpError(404, "not_found", "Active API key not found");
      if (active.length === 1) throw new HttpError(409, "last_api_key", "Issue a new API key before revoking the last active one");
      const [row] = await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.merchantId, req.merchantId!)))
        .returning();
      return toApiKey(row!);
    });
  });
}
