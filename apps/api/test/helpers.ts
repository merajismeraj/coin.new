import { randomUUID } from "node:crypto";
import type { Db } from "@coinnew/db";
import { createTestDb } from "@coinnew/db/testing";
import type { CreateMerchantResponse } from "@coinnew/shared-types";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export const EVM_WALLET = "0x1111111111111111111111111111111111111111";
export const SOL_WALLET = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

export interface Ctx {
  app: FastifyInstance;
  db: Db;
  close: () => Promise<void>;
}

export async function setup(overrides: Partial<Config> = {}): Promise<Ctx> {
  const { db, close } = await createTestDb();
  const config = { ...loadConfig({ CHECKOUT_BASE_URL: "https://pay.test" }), rateLimit: { enabled: false, readsPerMinute: 1000, writesPerMinute: 100 }, ...overrides };
  const app = await buildApp({ db, config, logger: false });
  return { app, db, close: async () => (await app.close(), await close()) };
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
    body: { business_name: "Acme FZ-LLC", email: `m${++n}@acme.test`, country_code: "ae", default_receiving_wallet: EVM_WALLET, ...body },
  });
  if (res.statusCode !== 201) throw new Error(`onboard failed: ${res.body}`);
  return res.json();
}
