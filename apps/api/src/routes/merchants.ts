import { apiKeys, merchants, type Db } from "@coinnew/db";
import {
  chainFamily,
  CHAINS,
  CreateApiKeyBody,
  OPT_IN_CHAINS,
  CreateMerchantBody,
  UpdateMerchantBody,
  type Chain,
  type ChainFamily,
  type CreateMerchantResponse,
  type IssuedApiKey,
  type ReceivingWallets,
} from "@coinnew/shared-types";
import { checksumEvm } from "../lib/address.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { generateApiKey } from "../lib/api-keys.js";
import { HttpError, isUniqueViolation, parse } from "../lib/errors.js";
import { toApiKey, toMerchant } from "../lib/serialize.js";
import { requireMerchant } from "../plugins/auth.js";
import { newSigningSecret } from "../services/webhooks.js";
import { addBankAccount, enableFiatPayout, getPartnerStatus, startOnboarding, type PartnerDeps } from "../services/partners.js";
import { BankAccountBody, type WalletHoldings } from "@coinnew/shared-types";
import { HoldingsService } from "../services/holdings.js";

const REDACTED = "[redacted: shown once at creation]";

const families = (w: ReceivingWallets) => new Set<ChainFamily>([...(w.evm ? ["evm" as const] : []), ...(w.solana ? ["solana" as const] : [])]);

/** Chains enabled when the merchant doesn't choose: every chain of their wallets' families, except opt-in chains. */
const defaultChainsFor = (have: Set<ChainFamily>) => CHAINS.filter((c) => have.has(chainFamily(c)) && !OPT_IN_CHAINS.includes(c));

/** Every enabled chain needs a receiving wallet of its family. */
function resolveChains(wallets: ReceivingWallets, requested: Chain[] | undefined): Chain[] {
  const have = families(wallets);
  if (!requested) return defaultChainsFor(have);
  const missing = requested.filter((c) => !have.has(chainFamily(c)));
  if (missing.length) {
    throw new HttpError(422, "chain_wallet_mismatch", `No receiving wallet for: ${missing.join(", ")}. Add a ${chainFamily(missing[0]!)} wallet first.`);
  }
  return requested;
}

/** Checksums EVM addresses so they display and compare consistently. */
const normalizeEvm = (a: string | null | undefined) => (a ? checksumEvm(a, "receiving_wallets.evm") : a);

async function issueKey(db: Db, merchantId: string, label: string | null): Promise<IssuedApiKey> {
  const key = await generateApiKey();
  const [row] = await db.insert(apiKeys).values({ id: key.id, merchantId, keyHash: key.hash, label }).returning();
  return { ...toApiKey(row!), key: key.plaintext };
}

export async function merchantRoutes(app: FastifyInstance, { db, partners }: { db: Db; partners: PartnerDeps }) {
  // Public onboarding. Returns the first API key exactly once.
  app.post(
    "/v1/merchants",
    { config: { redactReplay: (b: CreateMerchantResponse) => ({ ...b, api_key: { ...b.api_key, key: REDACTED } }) } },
    async (req, reply) => {
      const body = parse(CreateMerchantBody, req.body);
      const wallets = { evm: normalizeEvm(body.receiving_wallets.evm) ?? null, solana: body.receiving_wallets.solana ?? null };
      const preferredChains = resolveChains(wallets, body.preferred_chains);
      const result = await db
        .transaction(async (tx) => {
          const [m] = await tx
            .insert(merchants)
            .values({
              businessName: body.business_name,
              email: body.email,
              countryCode: body.country_code,
              evmWallet: wallets.evm,
              solanaWallet: wallets.solana,
              preferredChains,
              webhookSigningSecret: newSigningSecret(),
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

  const holdings = new HoldingsService(partners.verifier, partners.config.network);

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
      const before: ReceivingWallets = { evm: current.evmWallet, solana: current.solanaWallet };
      const input = body.receiving_wallets ?? {};
      const wallets: ReceivingWallets = {
        evm: input.evm === undefined ? before.evm : (normalizeEvm(input.evm) ?? null),
        solana: input.solana === undefined ? before.solana : input.solana,
      };
      if (!wallets.evm && !wallets.solana) throw new HttpError(422, "wallet_required", "At least one receiving wallet is required");

      // Without explicit chains: keep what still has a wallet, and enable chains of a newly added family.
      const had = families(before);
      const has = families(wallets);
      const chains =
        body.preferred_chains ??
        CHAINS.filter((c) => has.has(chainFamily(c)) && ((current.preferredChains as Chain[]).includes(c) || (!had.has(chainFamily(c)) && defaultChainsFor(has).includes(c))));
      const preferredChains = resolveChains(wallets, chains.length ? chains : undefined);

      // Fiat payout routes checkout payments to partner liquidation addresses; provision them first.
      if (body.payout_preference === "fiat_via_partner") {
        await enableFiatPayout(partners, { ...current, preferredChains });
      }
      const [m] = await db
        .update(merchants)
        .set({
          evmWallet: wallets.evm,
          solanaWallet: wallets.solana,
          preferredChains,
          ...(body.webhook_url !== undefined && { webhookUrl: body.webhook_url }),
          ...(body.payout_preference && { payoutPreference: body.payout_preference }),
        })
        .where(eq(merchants.id, req.merchantId!))
        .returning();
      return toMerchant(m!);
    });

    // Stablecoins sitting in the merchant's own receiving wallets, read from chain.
    authed.get("/v1/merchants/me/holdings", async (req): Promise<WalletHoldings> => {
      const m = await loadMe(req.merchantId!);
      return holdings.get({ id: m.id, evmWallet: m.evmWallet, solanaWallet: m.solanaWallet, preferredChains: m.preferredChains as Chain[] });
    });

    // Secret used to sign outbound webhooks (X-coinnew-Signature). Readable by the merchant, like any webhook secret.
    authed.get("/v1/merchants/me/webhook-secret", async (req) => {
      const m = await loadMe(req.merchantId!);
      if (m.webhookSigningSecret) return { secret: m.webhookSigningSecret };
      const secret = newSigningSecret();
      await db.update(merchants).set({ webhookSigningSecret: secret }).where(and(eq(merchants.id, m.id), isNull(merchants.webhookSigningSecret)));
      return { secret: (await loadMe(m.id)).webhookSigningSecret };
    });

    authed.post(
      "/v1/merchants/me/webhook-secret/rotate",
      { config: { redactReplay: () => ({ secret: REDACTED }) } },
      async (req) => {
        const secret = newSigningSecret();
        await db.update(merchants).set({ webhookSigningSecret: secret }).where(eq(merchants.id, req.merchantId!));
        return { secret };
      },
    );

    // ---- Licensed partner (Bridge): KYB, payout bank account -------------------
    authed.get("/v1/merchants/me/partner", async (req) => getPartnerStatus(partners, req.merchantId!));

    authed.post("/v1/merchants/me/partner/onboarding", async (req) => {
      const body = parse(z.object({ redirect_uri: z.string().url().optional() }), req.body ?? {});
      return startOnboarding(partners, await loadMe(req.merchantId!), body.redirect_uri);
    });

    // Bank details pass through to the partner; only its id and last 4 digits are kept.
    authed.post("/v1/merchants/me/partner/bank-account", async (req) =>
      addBankAccount(partners, await loadMe(req.merchantId!), parse(BankAccountBody, req.body)),
    );

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
