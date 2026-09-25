import { createHmac } from "node:crypto";
import { alchemyWatchedAddresses, alchemyWebhooks, liquidationAddresses, paymentIntents } from "@coinnew/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlchemyNotifyError, type AlchemyNotifyApi, type AlchemyWebhook } from "../src/indexers/alchemy-notify.js";
import { syncAlchemyAddresses, type AlchemySyncDeps } from "../src/services/alchemy-sync.js";
import { call, EVM_WALLET, onboard, PAYER_EVM, setup, type Ctx } from "./helpers.js";

const HOOK_URL = "https://api.coin.test/internal/webhooks/chain-indexer/alchemy";
const W2 = "0x2222222222222222222222222222222222222222";

/** In-memory Alchemy Notify. */
class FakeAlchemy implements AlchemyNotifyApi {
  hooks = new Map<string, AlchemyWebhook & { addresses: Set<string> }>();
  calls: string[] = [];
  failNext: Error | null = null;
  private n = 0;
  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }
  async listWebhooks() {
    this.calls.push("list");
    return [...this.hooks.values()];
  }
  async createAddressWebhook({ network, webhookUrl, addresses }: { network: string; webhookUrl: string; addresses: string[] }) {
    this.maybeFail();
    this.calls.push(`create:${network}`);
    const id = `wh_${++this.n}`;
    const h = { id, network, webhook_type: "ADDRESS_ACTIVITY", webhook_url: webhookUrl, is_active: true, signing_key: `whsec_${id}`, addresses: new Set(addresses) };
    this.hooks.set(id, h);
    return h;
  }
  async updateAddresses({ webhookId, add, remove }: { webhookId: string; add: string[]; remove: string[] }) {
    this.maybeFail();
    const h = this.hooks.get(webhookId);
    if (!h) throw new AlchemyNotifyError(404, "webhook not found");
    this.calls.push(`update:${h.network}:+${add.length}-${remove.length}`);
    add.forEach((a) => h.addresses.add(a));
    remove.forEach((a) => h.addresses.delete(a));
  }
  async listAddresses(webhookId: string) {
    this.calls.push("addresses");
    return [...(this.hooks.get(webhookId)?.addresses ?? [])];
  }
  on(network: string) {
    return [...this.hooks.values()].find((h) => h.network === network);
  }
}

let ctx: Ctx;
let fake: FakeAlchemy;
let deps: AlchemySyncDeps;
let key: string;
beforeEach(async () => {
  ctx = await setup();
  fake = new FakeAlchemy();
  deps = { db: ctx.db, api: fake, network: "mainnet", webhookUrl: HOOK_URL };
  key = (await onboard(ctx.app, { receiving_wallets: { evm: EVM_WALLET } })).api_key.key;
  await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { preferred_chains: ["base", "polygon"] } });
});
afterEach(() => ctx.close());

const lower = (a: string) => a.toLowerCase();

describe("alchemy address auto-registration", () => {
  it("creates one webhook per EVM network and watches merchant wallets on enabled chains only", async () => {
    const r = await syncAlchemyAddresses(deps);
    expect(r).toHaveLength(3);
    expect([...fake.on("BASE_MAINNET")!.addresses]).toEqual([lower(EVM_WALLET)]);
    expect([...fake.on("MATIC_MAINNET")!.addresses]).toEqual([lower(EVM_WALLET)]);
    expect([...fake.on("ETH_MAINNET")!.addresses]).toEqual([]); // ethereum not enabled
    const stored = await ctx.db.select().from(alchemyWebhooks);
    expect(stored.map((w) => w.alchemyNetwork).sort()).toEqual(["BASE_MAINNET", "ETH_MAINNET", "MATIC_MAINNET"]);
    expect(stored.every((w) => w.webhookUrl === HOOK_URL && w.signingKey.startsWith("whsec_"))).toBe(true);
  });

  it("is idempotent: a second run makes no changes", async () => {
    await syncAlchemyAddresses(deps);
    fake.calls = [];
    const r = (await syncAlchemyAddresses(deps)) as { added: number; removed: number }[];
    expect(r.every((x) => x.added === 0 && x.removed === 0)).toBe(true);
    expect(fake.calls.filter((c) => c.startsWith("create") || c.startsWith("update"))).toEqual([]);
  });

  it("follows wallet changes, keeping the old address while an open intent still points to it", async () => {
    await syncAlchemyAddresses(deps);
    const inv = (await call(ctx.app, "POST", "/v1/invoices", { key, body: { amount_usd: "10", accepted_chains: ["base"] } })).json();
    await call(ctx.app, "POST", `/v1/checkout/${inv.id}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } });
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { receiving_wallets: { evm: W2 } } });

    await syncAlchemyAddresses(deps);
    expect([...fake.on("BASE_MAINNET")!.addresses].sort()).toEqual([lower(EVM_WALLET), lower(W2)].sort());
    expect([...fake.on("MATIC_MAINNET")!.addresses]).toEqual([lower(W2)]); // no intent there

    await ctx.db.update(paymentIntents).set({ status: "closed" });
    await syncAlchemyAddresses(deps);
    expect([...fake.on("BASE_MAINNET")!.addresses]).toEqual([lower(W2)]);
  });

  it("watches partner liquidation addresses", async () => {
    const m = (await call(ctx.app, "GET", "/v1/merchants/me", { key })).json();
    await ctx.db.insert(liquidationAddresses).values({ merchantId: m.id, chain: "ethereum", token: "USDC", address: "0x000000000000000000000000000000000000bEEF", externalId: "liq_1", externalAccountId: "ext_1" });
    await syncAlchemyAddresses(deps);
    expect([...fake.on("ETH_MAINNET")!.addresses]).toEqual(["0x000000000000000000000000000000000000beef"]);
  });

  it("adopts an existing webhook for our URL instead of creating a duplicate", async () => {
    await fake.createAddressWebhook({ network: "BASE_MAINNET", webhookUrl: HOOK_URL, addresses: ["0x9999999999999999999999999999999999999999"] });
    fake.calls = [];
    const r = (await syncAlchemyAddresses(deps)) as { alchemyNetwork: string; adopted?: boolean }[];
    expect(r.find((x) => x.alchemyNetwork === "BASE_MAINNET")!.adopted).toBe(true);
    expect(fake.calls.filter((c) => c === "create:BASE_MAINNET")).toEqual([]);
    // Its stale address is pruned, ours added.
    expect([...fake.on("BASE_MAINNET")!.addresses]).toEqual([lower(EVM_WALLET)]);
  });

  it("heals drift on the periodic full resync", async () => {
    await syncAlchemyAddresses(deps);
    const h = fake.on("BASE_MAINNET")!;
    h.addresses.delete(lower(EVM_WALLET)); // removed out-of-band
    h.addresses.add("0x7777777777777777777777777777777777777777"); // added out-of-band
    await syncAlchemyAddresses(deps);
    expect([...h.addresses]).toContain("0x7777777777777777777777777777777777777777"); // not yet: no full resync
    await ctx.db.update(alchemyWebhooks).set({ lastFullSyncAt: new Date(Date.now() - 7 * 3600_000) });
    await syncAlchemyAddresses(deps);
    expect([...h.addresses]).toEqual([lower(EVM_WALLET)]);
  });

  it("retries after an API failure and recreates a webhook deleted on Alchemy's side", async () => {
    await syncAlchemyAddresses(deps);
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { receiving_wallets: { evm: W2 } } });
    fake.failNext = new AlchemyNotifyError(500, "boom");
    const r1 = (await syncAlchemyAddresses(deps)) as { error?: string }[];
    expect(r1.some((x) => x.error)).toBe(true);
    await syncAlchemyAddresses(deps);
    expect([...fake.on("BASE_MAINNET")!.addresses]).toEqual([lower(W2)]);

    const old = fake.on("MATIC_MAINNET")!;
    fake.hooks.delete(old.id);
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { receiving_wallets: { evm: EVM_WALLET } } });
    await syncAlchemyAddresses(deps); // 404 → forget
    await syncAlchemyAddresses(deps); // recreate
    expect([...fake.on("MATIC_MAINNET")!.addresses]).toEqual([lower(EVM_WALLET)]);
  });

  it("does nothing when not configured, and runs one sync at a time", async () => {
    expect(await syncAlchemyAddresses({ ...deps, api: null })).toBe("not_configured");
    const [a, b] = await Promise.all([syncAlchemyAddresses(deps), syncAlchemyAddresses(deps)]);
    expect(fake.calls.filter((c) => c.startsWith("create"))).toHaveLength(3);
    expect([a, b].filter(Array.isArray)).not.toHaveLength(0);
    expect(await ctx.db.select().from(alchemyWatchedAddresses)).toHaveLength(2);
  });

  it("accepts inbound webhooks signed with an auto-managed signing key", async () => {
    await syncAlchemyAddresses(deps);
    const signingKey = fake.on("BASE_MAINNET")!.signing_key;
    const body = JSON.stringify({ event: { network: "BASE_MAINNET", activity: [{ hash: `0x${"1".repeat(64)}`, category: "token" }] } });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/webhooks/chain-indexer/alchemy",
      headers: { "content-type": "application/json", "x-alchemy-signature": createHmac("sha256", signingKey).update(body).digest("hex") },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1 });
  });
});

describe("AlchemyNotifyClient", () => {
  it("sends the auth token, uses Notify endpoints, and follows address pagination", async () => {
    const { AlchemyNotifyClient } = await import("../src/indexers/alchemy-notify.js");
    const seen: { method: string; url: string; token: string | null; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ method: init.method!, url, token: new Headers(init.headers).get("x-alchemy-token"), body: init.body ? JSON.parse(init.body as string) : null });
      const u = new URL(url);
      if (u.pathname.endsWith("/webhook-addresses")) {
        const page2 = u.searchParams.get("after") === "c1";
        return Response.json(page2 ? { data: ["0xb"], pagination: { cursors: {} } } : { data: ["0xa"], pagination: { cursors: { after: "c1" } } });
      }
      if (u.pathname.endsWith("/create-webhook")) return Response.json({ data: { id: "wh_1", signing_key: "whsec_1" } });
      if (u.pathname.endsWith("/update-webhook-addresses")) return new Response(null, { status: 200 });
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const c = new AlchemyNotifyClient("tok_123", "https://dashboard.alchemy.test/api", fetchImpl);

    expect(await c.listAddresses("wh_1")).toEqual(["0xa", "0xb"]);
    await c.createAddressWebhook({ network: "BASE_MAINNET", webhookUrl: HOOK_URL, addresses: ["0xa"] });
    await c.updateAddresses({ webhookId: "wh_1", add: ["0xc"], remove: ["0xa"] });
    await expect(c.listWebhooks()).rejects.toMatchObject({ status: 404 });

    expect(seen.every((s) => s.token === "tok_123")).toBe(true);
    expect(seen[2]).toMatchObject({ method: "POST", body: { network: "BASE_MAINNET", webhook_type: "ADDRESS_ACTIVITY", webhook_url: HOOK_URL, addresses: ["0xa"] } });
    expect(seen[3]).toMatchObject({ method: "PATCH", body: { webhook_id: "wh_1", addresses_to_add: ["0xc"], addresses_to_remove: ["0xa"] } });
  });
});
