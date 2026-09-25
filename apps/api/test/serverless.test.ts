import { createHmac } from "node:crypto";
import { tokenInfo } from "@coinnew/chains";
import { inboundEvents } from "@coinnew/db";
import { afterEach, describe, expect, it } from "vitest";
import { runJobsOnce, type Job } from "../src/jobs.js";
import { call, onboard, PAYER_EVM, setup, type Ctx } from "./helpers.js";

let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const log = { error: () => {} } as never;

describe("cron tick (serverless job runner)", () => {
  it("is not registered without CRON_SECRET", async () => {
    ctx = await setup();
    expect((await ctx!.app.inject({ method: "GET", url: "/internal/cron/tick" })).statusCode).toBe(404);
  });

  it("requires the bearer secret and runs every job once", async () => {
    ctx = await setup({ cronSecret: "s3cret" });
    expect((await ctx!.app.inject({ method: "GET", url: "/internal/cron/tick" })).statusCode).toBe(401);
    expect((await ctx!.app.inject({ method: "GET", url: "/internal/cron/tick", headers: { authorization: "Bearer wrong!" } })).statusCode).toBe(401);
    const res = await ctx!.app.inject({ method: "GET", url: "/internal/cron/tick", headers: { authorization: "Bearer s3cret" } });
    expect(res.statusCode).toBe(200);
    const jobs = res.json().jobs as Record<string, string>;
    expect(Object.keys(jobs)).toContain("fallback-scan");
    expect(Object.values(jobs).every((r) => r === "ok")).toBe(true);
  });
});

describe("runJobsOnce", () => {
  it("isolates failures and skips what's left once the budget is spent", async () => {
    let t = 0;
    const ran: string[] = [];
    const jobs: Job[] = [
      { name: "a", everyMs: 1, run: async () => void ran.push("a") },
      {
        name: "boom",
        everyMs: 1,
        run: async () => {
          throw new Error("x");
        },
      },
      { name: "slow", everyMs: 1, run: async () => void (t += 100) },
      { name: "late", everyMs: 1, run: async () => void ran.push("late") },
    ];
    expect(await runJobsOnce(jobs, { budgetMs: 50, log, now: () => t })).toEqual({ a: "ok", boom: "failed", slow: "ok", late: "skipped" });
    expect(ran).toEqual(["a"]);
  });
});

describe("inline webhook processing", () => {
  const webhook = (hash: string) => {
    const body = JSON.stringify({ webhookId: "wh", id: "e", type: "ADDRESS_ACTIVITY", event: { network: "BASE_MAINNET", activity: [{ hash, category: "token" }] } });
    return ctx!.app.inject({
      method: "POST",
      url: "/internal/webhooks/chain-indexer/alchemy",
      headers: { "content-type": "application/json", "x-alchemy-signature": createHmac("sha256", "whsk_test").update(body).digest("hex") },
      payload: body,
    });
  };

  it("settles a payment in the webhook request itself, with no job runner", async () => {
    ctx = await setup({ inlineWebhookProcessing: true });
    const key = (await onboard(ctx!.app)).api_key.key;
    const inv = (await call(ctx!.app, "POST", "/v1/invoices", { key, body: { amount_usd: "50" } })).json();
    const i = (await call(ctx!.app, "POST", `/v1/checkout/${inv.id}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } })).json();
    const tx = `0x${"cd".repeat(32)}`;
    ctx!.chain.publish("base", tx, [{ logIndex: 0, tokenAddress: tokenInfo("mainnet", "base", "USDC")!.address, from: PAYER_EVM, to: i.to_address, amountUnits: BigInt(i.amount_units) }]);

    expect((await webhook(tx)).statusCode).toBe(202);
    expect((await call(ctx!.app, "GET", `/v1/invoices/${inv.id}`, { key })).json().status).toBe("paid");
  });

  it("still accepts and stores the event when processing fails, for the job runner to retry", async () => {
    ctx = await setup({ inlineWebhookProcessing: true });
    ctx!.chain.verify = async () => {
      throw new Error("rpc down");
    };
    const tx = `0x${"ef".repeat(32)}`;
    expect((await webhook(tx)).statusCode).toBe(202);
    const [e] = await ctx!.db.select().from(inboundEvents);
    expect(e).toMatchObject({ txHash: tx, processedAt: null });
  });
});
