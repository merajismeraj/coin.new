import type { Network } from "@coinnew/chains";
import { alchemyWatchedAddresses, alchemyWebhooks, liquidationAddresses, merchants, paymentIntents, type Db } from "@coinnew/db";
import type { Chain } from "@coinnew/shared-types";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ALCHEMY_NETWORKS, AlchemyNotifyError, type AlchemyNotifyApi } from "../indexers/alchemy-notify.js";

const BATCH = 500;
const FULL_RESYNC_MS = 6 * 3600_000;
const LOCK_KEY = 0x636f696e; // "coin"

export interface AlchemySyncDeps {
  db: Db;
  api: AlchemyNotifyApi | null;
  network: Network;
  webhookUrl: string | null;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export interface NetworkSyncResult {
  alchemyNetwork: string;
  added: number;
  removed: number;
  created?: boolean;
  adopted?: boolean;
  resynced?: boolean;
  error?: string;
}

/**
 * The addresses Alchemy must watch on a chain: merchant wallets with the chain
 * enabled, partner liquidation addresses, and any address an open payment
 * intent still points to (so a wallet change can't orphan an in-flight payment).
 */
export async function desiredAddresses(db: Db, chain: Chain): Promise<Set<string>> {
  const [wallets, liq, intents] = await Promise.all([
    db
      .select({ a: merchants.evmWallet })
      .from(merchants)
      .where(and(isNotNull(merchants.evmWallet), sql`${chain} = ANY(${merchants.preferredChains})`)),
    db.select({ a: liquidationAddresses.address }).from(liquidationAddresses).where(eq(liquidationAddresses.chain, chain)),
    db.selectDistinct({ a: paymentIntents.toAddress }).from(paymentIntents).where(and(eq(paymentIntents.status, "open"), eq(paymentIntents.chain, chain))),
  ]);
  return new Set([...wallets, ...liq, ...intents].map((r) => r.a!.toLowerCase()));
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

/**
 * Reconciles Alchemy Address Activity webhooks with the desired watch set.
 * Idempotent and safe to call from every worker: a Postgres advisory lock lets
 * one run at a time, and Alchemy add/remove are themselves idempotent.
 */
export async function syncAlchemyAddresses(deps: AlchemySyncDeps): Promise<NetworkSyncResult[] | "not_configured" | "locked"> {
  const { api, webhookUrl } = deps;
  if (!api || !webhookUrl) return "not_configured";

  return deps.db.transaction(async (tx) => {
    const lock = rowsOf(await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`));
    if (!lock[0]?.locked) return "locked";

    const results: NetworkSyncResult[] = [];
    for (const [chain, alchemyNetwork] of Object.entries(ALCHEMY_NETWORKS[deps.network]) as [Chain, string][]) {
      const r: NetworkSyncResult = { alchemyNetwork, added: 0, removed: 0 };
      try {
        const desired = await desiredAddresses(tx as unknown as Db, chain);
        let [wh] = await tx.select().from(alchemyWebhooks).where(eq(alchemyWebhooks.alchemyNetwork, alchemyNetwork));

        if (!wh) {
          // Adopt an existing webhook pointing at us (e.g. after a DB restore) before creating a duplicate.
          const existing = (await api.listWebhooks()).find(
            (w) => w.network === alchemyNetwork && w.webhook_type === "ADDRESS_ACTIVITY" && w.webhook_url === webhookUrl,
          );
          if (existing) {
            [wh] = await tx
              .insert(alchemyWebhooks)
              .values({ alchemyNetwork, webhookId: existing.id, webhookUrl, signingKey: existing.signing_key, lastFullSyncAt: null })
              .returning();
            r.adopted = true;
          } else {
            const initial = [...desired].slice(0, BATCH);
            const created = await api.createAddressWebhook({ network: alchemyNetwork, webhookUrl, addresses: initial });
            [wh] = await tx
              .insert(alchemyWebhooks)
              .values({ alchemyNetwork, webhookId: created.id, webhookUrl, signingKey: created.signing_key, lastFullSyncAt: new Date() })
              .returning();
            if (initial.length) await tx.insert(alchemyWatchedAddresses).values(initial.map((address) => ({ alchemyNetwork, address })));
            r.created = true;
            r.added += initial.length;
          }
        }

        // Periodically trust Alchemy's own list over ours, to heal any drift.
        if (!wh!.lastFullSyncAt || Date.now() - wh!.lastFullSyncAt.getTime() > FULL_RESYNC_MS) {
          const remote = [...new Set((await api.listAddresses(wh!.webhookId)).map((a) => a.toLowerCase()))];
          await tx.delete(alchemyWatchedAddresses).where(eq(alchemyWatchedAddresses.alchemyNetwork, alchemyNetwork));
          for (const c of chunks(remote, BATCH)) await tx.insert(alchemyWatchedAddresses).values(c.map((address) => ({ alchemyNetwork, address })));
          await tx.update(alchemyWebhooks).set({ lastFullSyncAt: new Date() }).where(eq(alchemyWebhooks.alchemyNetwork, alchemyNetwork));
          r.resynced = true;
        }

        const watched = new Set(
          (await tx.select({ a: alchemyWatchedAddresses.address }).from(alchemyWatchedAddresses).where(eq(alchemyWatchedAddresses.alchemyNetwork, alchemyNetwork))).map((x) => x.a),
        );
        const add = [...desired].filter((a) => !watched.has(a));
        const remove = [...watched].filter((a) => !desired.has(a));

        for (const c of chunks(add, BATCH)) {
          await api.updateAddresses({ webhookId: wh!.webhookId, add: c, remove: [] });
          await tx.insert(alchemyWatchedAddresses).values(c.map((address) => ({ alchemyNetwork, address }))).onConflictDoNothing();
          r.added += c.length;
        }
        for (const c of chunks(remove, BATCH)) {
          await api.updateAddresses({ webhookId: wh!.webhookId, add: [], remove: c });
          await tx.delete(alchemyWatchedAddresses).where(and(eq(alchemyWatchedAddresses.alchemyNetwork, alchemyNetwork), inArray(alchemyWatchedAddresses.address, c)));
          r.removed += c.length;
        }
      } catch (err) {
        r.error = (err as Error).message.slice(0, 300);
        // The webhook was deleted on Alchemy's side: forget it so the next run recreates it.
        if (err instanceof AlchemyNotifyError && err.status === 404) {
          await tx.delete(alchemyWebhooks).where(eq(alchemyWebhooks.alchemyNetwork, alchemyNetwork));
        }
        deps.log?.warn({ alchemyNetwork, err: r.error }, "alchemy address sync failed");
      }
      if (r.added || r.removed || r.created || r.adopted || r.error) deps.log?.info({ ...r }, "alchemy address sync");
      results.push(r);
    }
    return results;
  });
}

/** Signing keys of auto-managed webhooks, cached briefly for the inbound route. */
export function alchemySigningKeyCache(db: Db, ttlMs = 60_000) {
  let cached: { at: number; keys: string[] } | null = null;
  return async () => {
    if (!cached || Date.now() - cached.at > ttlMs) {
      const rows = await db.select({ k: alchemyWebhooks.signingKey }).from(alchemyWebhooks);
      cached = { at: Date.now(), keys: rows.map((r) => r.k) };
    }
    return cached.keys;
  };
}
