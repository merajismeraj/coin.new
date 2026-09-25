import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tokenInfo } from "@coinnew/chains";
import { inboundEvents, invoices, paymentIntents, settlements, webhookDeliveries } from "@coinnew/db";
import type { OnchainIntent } from "@coinnew/shared-types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeStaleIntents, processInboundEvents, recheckUnconfirmed, scanOpenIntents } from "../src/services/payments.js";
import { assertPublicTarget, deliverDueWebhooks, signWebhook } from "../src/services/webhooks.js";
import { call, EVM_WALLET, onboard, PAYER_EVM, PAYER_SOL, SANCTIONED_EVM, setup, SOL_WALLET, type Ctx } from "./helpers.js";

let ctx: Ctx;
let key: string;
beforeEach(async () => {
  ctx = await setup();
  key = (await onboard(ctx.app, { receiving_wallets: { evm: EVM_WALLET, solana: SOL_WALLET } })).api_key.key;
  await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { webhook_url: "https://merchant.test/hooks" } });
});
afterEach(() => ctx.close());

const BASE_USDC = tokenInfo("mainnet", "base", "USDC")!.address;
const SOL_USDC = tokenInfo("mainnet", "solana", "USDC")!.address;
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const newInvoice = async (body: Record<string, unknown> = {}) => (await call(ctx.app, "POST", "/v1/invoices", { key, body: { amount_usd: "1200.00", ...body } })).json();
const intent = async (invoiceId: string, body: Record<string, unknown> = {}) =>
  call(ctx.app, "POST", `/v1/checkout/${invoiceId}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM, ...body } });
const invoiceStatus = async (id: string) => (await call(ctx.app, "GET", `/v1/invoices/${id}`, { key })).json();

const alchemy = (payload: unknown, signingKey = "whsk_test") => {
  const body = JSON.stringify(payload);
  return ctx.app.inject({
    method: "POST",
    url: "/internal/webhooks/chain-indexer/alchemy",
    headers: { "content-type": "application/json", "x-alchemy-signature": createHmac("sha256", signingKey).update(body).digest("hex") },
    payload: body,
  });
};
const alchemyActivity = (hash: string) => ({ webhookId: "wh_1", id: "evt_1", type: "ADDRESS_ACTIVITY", event: { network: "BASE_MAINNET", activity: [{ hash, category: "token" }] } });

/** Buyer pays the intent on the fake chain and Alchemy notifies us. */
async function pay(i: OnchainIntent, tx: string, opts: { final?: boolean; amount?: bigint; from?: string } = {}) {
  ctx.chain.publish("base", tx, [{ logIndex: 3, tokenAddress: i.token_address, from: opts.from ?? PAYER_EVM, to: i.to_address, amountUnits: opts.amount ?? BigInt(i.amount_units) }], opts.final ?? true);
  expect((await alchemy(alchemyActivity(tx))).statusCode).toBe(202);
  await processInboundEvents(ctx.payments);
}
const deliveries = async () => (await ctx.db.select().from(webhookDeliveries)).map((d) => d.eventType).sort();

describe("payment intents", () => {
  it("reserves a unique sub-cent amount at the merchant's own address", async () => {
    const inv = await newInvoice();
    const res = await intent(inv.id);
    expect(res.statusCode).toBe(201);
    const i = res.json() as OnchainIntent;
    const suffix = BigInt(i.amount_units) - 1_200_000_000n;
    expect(suffix > 0n && suffix <= 9_999n).toBe(true);
    expect(i).toMatchObject({ chain: "base", chain_id: 8453, token: "USDC", token_address: BASE_USDC, decimals: 6, to_address: EVM_WALLET, payer_address: PAYER_EVM });
    expect(i.amount).toMatch(/^1200\.00\d+$/);
    expect((await invoiceStatus(inv.id)).buyer_wallet).toBe(PAYER_EVM);
  });

  it("reuses the open intent for the same payer and option, allocates a distinct amount otherwise", async () => {
    const inv = await newInvoice();
    const a = (await intent(inv.id)).json();
    expect((await intent(inv.id)).json().id).toBe(a.id);
    const b = (await intent(inv.id, { payer_address: "0x00000000000000000000000000000000000000bb" })).json();
    expect(b.id).not.toBe(a.id);
    expect(b.amount_units).not.toBe(a.amount_units);
  });

  it("rejects unsupported options, wrong wallet family, sanctioned payers and closed invoices", async () => {
    const inv = await newInvoice();
    expect((await intent(inv.id, { token: "USDT" })).json().error.code).toBe("option_unavailable");
    expect((await intent(inv.id, { chain: "solana" })).json().error.code).toBe("payer_wallet_mismatch");
    const blocked = await intent(inv.id, { payer_address: SANCTIONED_EVM });
    expect(blocked.statusCode).toBe(403);
    expect(JSON.stringify(blocked.json())).not.toMatch(/sanction/i);
    await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    expect((await intent(inv.id)).statusCode).toBe(409);
  });

  it("quotes at par without reserving", async () => {
    const inv = await newInvoice({ amount_usd: "19.99" });
    const q = (await call(ctx.app, "POST", `/v1/checkout/${inv.id}/quote`, { idem: null, body: { chain: "solana", token: "USDC" } })).json();
    expect(q).toMatchObject({ amount: "19.99", amount_units: "19990000", to_address: SOL_WALLET, token_address: SOL_USDC });
    expect(await ctx.db.select().from(paymentIntents)).toHaveLength(0);
  });
});

describe("settlement via indexer webhook", () => {
  it("rejects bad signatures and stores nothing", async () => {
    const res = await alchemy(alchemyActivity(TX(1)), "wrong-key");
    expect(res.statusCode).toBe(401);
    expect(await ctx.db.select().from(inboundEvents)).toHaveLength(0);
  });

  it("verifies on-chain, marks paid, records the settlement and queues merchant webhooks", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(1));

    const got = await invoiceStatus(inv.id);
    expect(got.status).toBe("paid");
    expect(got.settlements).toHaveLength(1);
    expect(got.settlements[0]).toMatchObject({ rail: "onchain", chain: "base", tx_hash: TX(1), token: "USDC", to_address: EVM_WALLET, risk_flags: [], amount: i.amount });
    expect(got.settlements[0].confirmed_at).not.toBeNull();
    expect(await deliveries()).toEqual(["invoice.paid", "settlement.confirmed"]);

    const [s] = await ctx.db.select().from(settlements);
    expect(s!.rawEvent).toMatchObject({ indexer_event: { source: "alchemy" }, verified: { amountUnits: i.amount_units, final: true } });

    const co = (await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json();
    expect(co).toMatchObject({ status: "paid", payment: { chain: "base", tx_hash: TX(1), confirmed: true, explorer_url: `https://basescan.org/tx/${TX(1)}` } });
  });

  it("is idempotent across duplicate notifications and rescans", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(2));
    await alchemy(alchemyActivity(TX(2)));
    await processInboundEvents(ctx.payments);
    await scanOpenIntents(ctx.payments);
    expect(await ctx.db.select().from(settlements)).toHaveLength(1);
    expect(await deliveries()).toEqual(["invoice.paid", "settlement.confirmed"]);
  });

  it("ignores transfers that don't match exactly (wrong amount or address)", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(3), { amount: 1_200_000_000n });
    ctx.chain.publish("base", TX(4), [{ logIndex: 0, tokenAddress: BASE_USDC, from: PAYER_EVM, to: PAYER_EVM, amountUnits: BigInt(i.amount_units) }]);
    await alchemy(alchemyActivity(TX(4)));
    await processInboundEvents(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("pending");
    expect(await ctx.db.select().from(settlements)).toHaveLength(0);
  });

  it("does not trust the webhook: a notification for a tx the chain doesn't have settles nothing and is retried", async () => {
    await alchemy(alchemyActivity(TX(5)));
    await processInboundEvents(ctx.payments);
    const [e] = await ctx.db.select().from(inboundEvents);
    expect(e).toMatchObject({ attempts: 1, processedAt: null, lastError: "transaction not found on chain" });
  });
});

describe("confirmations and reorgs", () => {
  it("shows processing until final, then paid", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(6), { final: false });
    expect((await invoiceStatus(inv.id)).status).toBe("processing");
    expect((await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json().payment.confirmed).toBe(false);
    expect(await deliveries()).toEqual([]);

    ctx.chain.finalize("base", TX(6));
    await recheckUnconfirmed(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("paid");
    expect(await deliveries()).toEqual(["invoice.paid", "settlement.confirmed"]);
  });

  it("reverts an unconfirmed transfer that was reorged out", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(7), { final: false });
    ctx.chain.drop("base", TX(7));
    await recheckUnconfirmed(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("processing"); // within grace period

    await ctx.db.update(settlements).set({ createdAt: new Date(Date.now() - 2 * 3600_000) });
    await recheckUnconfirmed(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("pending");
    expect(await ctx.db.select().from(settlements)).toHaveLength(0);
    const [pi] = await ctx.db.select().from(paymentIntents);
    expect(pi!.status).toBe("open");
  });
});

describe("edge cases", () => {
  it("records a late payment on a canceled invoice without reopening it", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    await pay(i, TX(8));
    const got = await invoiceStatus(inv.id);
    expect(got.status).toBe("canceled");
    expect(got.settlements).toHaveLength(1);
    expect(await deliveries()).toEqual(["invoice.canceled", "settlement.confirmed"]);
  });

  it("flags a payment sent from a sanctioned wallet", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    await pay(i, TX(9), { from: SANCTIONED_EVM });
    expect((await invoiceStatus(inv.id)).settlements[0].risk_flags).toEqual(["sanctions_match"]);
  });

  it("settles via the fallback scanner when no webhook arrives", async () => {
    const inv = await newInvoice();
    const i = (await intent(inv.id)).json();
    ctx.chain.publish("base", TX(10), [{ logIndex: 1, tokenAddress: BASE_USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: BigInt(i.amount_units) }]);
    await scanOpenIntents(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("paid");
  });

  it("doesn't re-verify a transfer already in the reconciliation inbox on later scans", async () => {
    const inv = await newInvoice();
    await intent(inv.id);
    ctx.chain.publish("base", TX(11), [{ logIndex: 1, tokenAddress: BASE_USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: 747_500_000n }]);
    await scanOpenIntents(ctx.payments);
    const inbox = (await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data;
    expect(inbox.map((u: { tx_hash: string }) => u.tx_hash)).toEqual([TX(11)]);
    const before = ctx.chain.calls;
    await scanOpenIntents(ctx.payments);
    expect(ctx.chain.calls).toBe(before);
  });

  it("settles Solana payments via Helius", async () => {
    const inv = await newInvoice({ accepted_chains: ["solana"] });
    const i = (await intent(inv.id, { chain: "solana", payer_address: PAYER_SOL })).json();
    expect(i.to_address).toBe(SOL_WALLET);
    ctx.chain.publish("solana", "5sig", [{ logIndex: null, tokenAddress: SOL_USDC, from: PAYER_SOL, to: SOL_WALLET, amountUnits: BigInt(i.amount_units) }]);

    const send = (auth: string) =>
      ctx.app.inject({ method: "POST", url: "/internal/webhooks/chain-indexer/helius", headers: { authorization: auth, "content-type": "application/json" }, payload: JSON.stringify([{ signature: "5sig" }]) });
    expect((await send("Bearer nope")).statusCode).toBe(401);
    expect((await send("Bearer helius-test")).statusCode).toBe(202);
    await processInboundEvents(ctx.payments);
    expect((await invoiceStatus(inv.id)).status).toBe("paid");
  });

  it("closes intents after the late-payment window, freeing their amount", async () => {
    const inv = await newInvoice();
    await intent(inv.id);
    await ctx.db.update(paymentIntents).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });
    await closeStaleIntents(ctx.db);
    expect((await ctx.db.select().from(paymentIntents))[0]!.status).toBe("closed");
  });
});

describe("outbound webhook delivery", () => {
  async function receiver(status = 200) {
    const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { webhook_url: url } });
    return { received, close: () => new Promise((r) => server.close(r)) };
  }

  it("signs each delivery with the merchant's secret", async () => {
    const rx = await receiver();
    const inv = await newInvoice();
    await pay((await intent(inv.id)).json(), TX(11));
    expect(await deliverDueWebhooks(ctx.db, { allowPrivateTargets: true })).toBe(2);
    await rx.close();

    const secret = (await call(ctx.app, "GET", "/v1/merchants/me/webhook-secret", { key })).json().secret;
    for (const r of rx.received) {
      const [, t] = /t=(\d+)/.exec(r.headers["x-coinnew-signature"] as string)!;
      expect(r.headers["x-coinnew-signature"]).toBe(signWebhook(secret, r.body, Number(t)));
    }
    const paid = rx.received.map((r) => JSON.parse(r.body)).find((e) => e.type === "invoice.paid");
    expect(paid.data).toMatchObject({ id: inv.id, status: "paid", settlements: [{ tx_hash: TX(11) }] });
    expect((await ctx.db.select().from(webhookDeliveries)).every((d) => d.status === "delivered")).toBe(true);
  });

  it("backs off on failure and dead-letters after 24h", async () => {
    const rx = await receiver(500);
    const inv = await newInvoice();
    await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    await deliverDueWebhooks(ctx.db, { allowPrivateTargets: true });
    let [d] = await ctx.db.select().from(webhookDeliveries);
    expect(d).toMatchObject({ status: "pending", attempts: 1, responseStatus: 500, lastError: "HTTP 500" });
    expect(d!.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(50_000);

    await ctx.db.update(webhookDeliveries).set({ createdAt: new Date(Date.now() - 24 * 3600_000), nextAttemptAt: new Date() });
    await deliverDueWebhooks(ctx.db, { allowPrivateTargets: true });
    [d] = await ctx.db.select().from(webhookDeliveries);
    expect(d!.status).toBe("failed");
    await rx.close();
  });

  it("refuses to deliver to private or internal addresses", async () => {
    await expect(assertPublicTarget("https://169.254.169.254/latest", false)).rejects.toThrow(/private/);
    await expect(assertPublicTarget("https://10.0.0.5/h", false)).rejects.toThrow(/private/);
    await expect(assertPublicTarget("https://[::1]/h", false)).rejects.toThrow(/private/);
    await expect(assertPublicTarget("https://1.1.1.1/h", false)).resolves.toBeUndefined();

    const rx = await receiver();
    const inv = await newInvoice();
    await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    await deliverDueWebhooks(ctx.db, { allowPrivateTargets: false });
    expect(rx.received).toHaveLength(0);
    expect((await ctx.db.select().from(webhookDeliveries))[0]!.lastError).toMatch(/https|private/);
    await rx.close();
  });
});

describe("invoice options", () => {
  it("expires lazily on read even with open intents", async () => {
    const inv = await newInvoice({ expires_in_hours: 1 });
    await intent(inv.id);
    await ctx.db.update(invoices).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invoices.id, inv.id));
    expect((await intent(inv.id)).json().error.code).toBe("not_payable");
  });
});

describe("Robinhood Chain", () => {
  it("settles a USDG payment found by the fallback scanner (no Notify webhook on this chain)", async () => {
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { preferred_chains: ["base", "robinhood"] } });
    const inv = await newInvoice();
    const i = (await intent(inv.id, { chain: "robinhood", token: "USDG" })).json() as OnchainIntent;
    expect(i).toMatchObject({ chain: "robinhood", chain_id: 4663, token: "USDG", token_address: tokenInfo("mainnet", "robinhood", "USDG")!.address, bridged: false, to_address: EVM_WALLET });

    ctx.chain.publish("robinhood", TX(0x4663), [{ logIndex: 0, tokenAddress: i.token_address, from: PAYER_EVM, to: i.to_address, amountUnits: BigInt(i.amount_units) }]);
    await scanOpenIntents(ctx.payments);

    const done = await invoiceStatus(inv.id);
    expect(done.status).toBe("paid");
    expect(done.settlements[0]).toMatchObject({ chain: "robinhood", token: "USDG", tx_hash: TX(0x4663) });
  });

  it("marks bridged USDC as bridged on the intent", async () => {
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { preferred_chains: ["robinhood"] } });
    const inv = await newInvoice();
    expect((await intent(inv.id, { chain: "robinhood", token: "USDC" })).json()).toMatchObject({ token: "USDC", bridged: true, token_address: "0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8" });
  });
});
