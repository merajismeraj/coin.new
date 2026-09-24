import { randomUUID } from "node:crypto";
import type { Db } from "@coinnew/db";
import { createTestDb } from "@coinnew/db/testing";
import type { CreateMerchantResponse } from "@coinnew/shared-types";
import type { FastifyInstance } from "fastify";
import type { ChainVerifier, ObservedTransfer, VerifiedTx } from "@coinnew/chains/verify";
import type { Chain } from "@coinnew/shared-types";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import type { PaymentDeps } from "../src/services/payments.js";
import type { BridgeApi } from "../src/rails/bridge.js";
import type { PartnerDeps } from "../src/services/partners.js";
import { DenylistScreener } from "../src/services/screening.js";

export const EVM_WALLET = "0x1111111111111111111111111111111111111111";
export const SOL_WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
export const PAYER_EVM = "0x00000000000000000000000000000000000000AA";
export const PAYER_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
export const SANCTIONED_EVM = "0x000000000000000000000000000000000000dEaD";

/** In-memory chain: tests publish transactions and advance finality. */
export class FakeChain implements ChainVerifier {
  txs = new Map<string, VerifiedTx>();
  heads: Partial<Record<Chain, bigint>> = {};
  calls = 0;

  publish(chain: Chain, txHash: string, transfers: Omit<ObservedTransfer, "chain" | "txHash">[], final = true) {
    this.txs.set(`${chain}:${txHash}`, { found: true, final, blockTime: new Date(), transfers: transfers.map((t) => ({ chain, txHash, ...t })) });
  }
  finalize(chain: Chain, txHash: string) {
    this.txs.get(`${chain}:${txHash}`)!.final = true;
  }
  drop(chain: Chain, txHash: string) {
    this.txs.delete(`${chain}:${txHash}`);
  }
  async verify(chain: Chain, txHash: string): Promise<VerifiedTx> {
    this.calls++;
    return this.txs.get(`${chain}:${txHash}`) ?? { found: false, final: false, blockTime: null, transfers: [] };
  }
  async scan(chain: Chain, { to }: { to: string }) {
    return [...this.txs.entries()]
      .filter(([k, v]) => k.startsWith(`${chain}:`) && v.transfers.some((t) => t.to.toLowerCase() === to.toLowerCase()))
      .map(([, v]) => v.transfers[0]!.txHash);
  }
  async head(chain: Chain) {
    return this.heads[chain] ?? 1000n;
  }
}

export interface Ctx {
  app: FastifyInstance;
  db: Db;
  chain: FakeChain;
  config: Config;
  payments: PaymentDeps;
  partners: PartnerDeps;
  close: () => Promise<void>;
}

export async function setup(overrides: Partial<Config> = {}, opts: { bridge?: BridgeApi | null } = {}): Promise<Ctx> {
  const { db, close } = await createTestDb();
  const config: Config = {
    ...loadConfig({ CHECKOUT_BASE_URL: "https://pay.test", NETWORK: "mainnet", ALCHEMY_SIGNING_KEYS: "whsk_test", HELIUS_AUTH_HEADER: "Bearer helius-test" }),
    rateLimit: { enabled: false, readsPerMinute: 1000, writesPerMinute: 100 },
    ...overrides,
  };
  const chain = new FakeChain();
  const screener = new DenylistScreener([SANCTIONED_EVM]);
  const app = await buildApp({ db, config, verifier: chain, screener, bridge: opts.bridge ?? null, logger: false });
  const payments: PaymentDeps = { db, verifier: chain, screener, network: config.network };
  const partners: PartnerDeps = { db, config, bridge: opts.bridge ?? null, verifier: chain, screener };
  return { app, db, chain, config, payments, partners, close: async () => (await app.close(), await close()) };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export function call(app: FastifyInstance, method: Method, url: string, opts: { key?: string; body?: unknown; idem?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (method !== "GET" && opts.idem !== null) headers["idempotency-key"] = opts.idem ?? randomUUID();
  return app.inject({ method, url, headers, payload: opts.body as never });
}

let n = 0;
export async function onboard(app: FastifyInstance, body: Record<string, unknown> = {}): Promise<CreateMerchantResponse> {
  const res = await call(app, "POST", "/v1/merchants", {
    body: { business_name: "Acme Ltd", email: `m${++n}@acme.test`, country_code: "gb", receiving_wallets: { evm: EVM_WALLET }, ...body },
  });
  if (res.statusCode !== 201) throw new Error(`onboard failed: ${res.body}`);
  return res.json();
}
