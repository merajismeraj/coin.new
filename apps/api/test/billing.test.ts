import { createHmac } from "node:crypto";
import { billingPeriods, emailOutbox, invoices, merchants } from "@coinnew/db";
import { tokenInfo } from "@coinnew/chains";
import type { BillingSummary, OnchainIntent } from "@coinnew/shared-types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths, currentPeriod, issueBills, sendBillingReminders } from "../src/services/billing.js";
import { processInboundEvents } from "../src/services/payments.js";
import { call, onboard, PAYER_EVM, setup, type Ctx } from "./helpers.js";

const PLATFORM_WALLET = "0x2222222222222222222222222222222222222222";
const BASE_USDC = tokenInfo("mainnet", "base", "USDC")!.address;
const DAY = 86_400_000;

describe("billing periods", () => {
  it("adds calendar months, clamping to the end of shorter months", () => {
    const jan31 = new Date("2027-01-31T10:00:00Z");
    expect(addMonths(jan31, 1).toISOString()).toBe("2027-02-28T10:00:00.000Z");
    expect(addMonths(jan31, 2).toISOString()).toBe("2027-03-31T10:00:00.000Z");
    expect(addMonths(new Date("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonths(new Date("2027-11-15T00:00:00Z"), 3).toISOString()).toBe("2028-02-15T00:00:00.000Z");
  });

  it("finds the period containing now, anchored to the plan start", () => {
    const start = new Date("2027-01-31T10:00:00Z");
    expect(currentPeriod(start, start)).toEqual({ start, end: new Date("2027-02-28T10:00:00Z") });
    expect(currentPeriod(start, new Date("2027-02-28T09:59:59Z")).start).toEqual(start);
    expect(currentPeriod(start, new Date("2027-02-28T10:00:00Z")).start).toEqual(new Date("2027-02-28T10:00:00Z"));
    expect(currentPeriod(start, new Date("2027-04-01T00:00:00Z"))).toEqual({ start: new Date("2027-03-31T10:00:00Z"), end: new Date("2027-04-30T10:00:00Z") });
  });
});

describe("subscription billing", () => {
  let ctx: Ctx;
  let key: string;
  let merchantId: string;
  let platformId: string;
  let platformKey: string;
  let tx = 0;

  beforeEach(async () => {
    ctx = await setup();
    const platform = await onboard(ctx.app, { business_name: "coin.new", receiving_wallets: { evm: PLATFORM_WALLET } });
    platformId = platform.merchant.id;
    platformKey = platform.api_key.key;
    // The app and job deps share this config object.
    ctx.config.billing = { platformMerchantId: platformId, priceUsd: "10.00", graceDays: 14 };
    const m = await onboard(ctx.app);
    key = m.api_key.key;
    merchantId = m.merchant.id;
  });
  afterEach(() => ctx.close());

  const summary = async (k = key) => (await call(ctx.app, "GET", "/v1/merchants/me/billing", { key: k })).json() as BillingSummary;
  const createInvoice = (amount = "100.00") => call(ctx.app, "POST", "/v1/invoices", { key, body: { amount_usd: amount } });

  /** Buyer pays an invoice on the fake chain; the indexer webhook triggers verification. */
  async function payInvoice(invoiceId: string) {
    const i = (await call(ctx.app, "POST", `/v1/checkout/${invoiceId}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } })).json() as OnchainIntent;
    const hash = `0x${(++tx).toString(16).padStart(64, "0")}`;
    ctx.chain.publish("base", hash, [{ logIndex: 0, tokenAddress: BASE_USDC, from: PAYER_EVM, to: i.to_address, amountUnits: BigInt(i.amount_units) }]);
    const body = JSON.stringify({ webhookId: "wh", id: `e${tx}`, type: "ADDRESS_ACTIVITY", event: { network: "BASE_MAINNET", activity: [{ hash, category: "token" }] } });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/internal/webhooks/chain-indexer/alchemy",
      headers: { "content-type": "application/json", "x-alchemy-signature": createHmac("sha256", "whsk_test").update(body).digest("hex") },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    await processInboundEvents(ctx.payments);
  }

  it("is free until the merchant's first payment: no plan, no bill", async () => {
    expect(await summary()).toMatchObject({ enabled: true, price_usd: "10.00", status: "free", started_at: null, next_bill_at: null, periods: [] });
    await createInvoice();
    expect(await issueBills(ctx.db, ctx.config)).toBe(0);
    expect(await ctx.db.select().from(billingPeriods)).toHaveLength(0);
  });

  it("starts the plan on the first confirmed payment and bills it through the platform's own invoice", async () => {
    const inv = (await createInvoice()).json();
    await payInvoice(inv.id);
    const [m] = await ctx.db.select().from(merchants).where(eq(merchants.id, merchantId));
    expect(m!.billingStartedAt).not.toBeNull();

    expect(await issueBills(ctx.db, ctx.config)).toBe(1);
    expect(await issueBills(ctx.db, ctx.config)).toBe(0);

    const s = await summary();
    expect(s.status).toBe("active");
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]).toMatchObject({ amount_usd: "10.00", status: "due" });
    expect(new Date(s.next_bill_at!).getTime()).toBe(addMonths(m!.billingStartedAt!, 1).getTime());

    // The bill is an ordinary invoice owned by the platform account, addressed to the merchant.
    const [bill] = await ctx.db.select().from(invoices).where(eq(invoices.merchantId, platformId));
    expect(bill).toMatchObject({ amountUsd: "10.00", buyerEmail: m!.email, expiresAt: null, metadata: { type: "subscription", billed_merchant_id: merchantId } });
    expect(s.periods[0]!.pay_url).toBe(bill!.checkoutUrl);
    const mails = await ctx.db.select().from(emailOutbox).where(eq(emailOutbox.template, "billing_invoice"));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ toAddress: m!.email, merchantId });

    // The platform account itself is never billed.
    expect(await summary(platformKey)).toMatchObject({ enabled: false, periods: [] });
  });

  it("issues one bill per period even when runners race", async () => {
    await ctx.db.update(merchants).set({ billingStartedAt: new Date() }).where(eq(merchants.id, merchantId));
    const results = await Promise.all([issueBills(ctx.db, ctx.config), issueBills(ctx.db, ctx.config), issueBills(ctx.db, ctx.config)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await ctx.db.select().from(billingPeriods)).toHaveLength(1);
    expect(await ctx.db.select().from(invoices).where(eq(invoices.merchantId, platformId))).toHaveLength(1);
  });

  it("bills again each month", async () => {
    const start = new Date(Date.now() - 40 * DAY);
    await ctx.db.update(merchants).set({ billingStartedAt: start }).where(eq(merchants.id, merchantId));
    await issueBills(ctx.db, ctx.config, start);
    await issueBills(ctx.db, ctx.config);
    const periods = await ctx.db.select().from(billingPeriods).orderBy(billingPeriods.periodStart);
    expect(periods.map((p) => p.periodStart.toISOString())).toEqual([start.toISOString(), addMonths(start, 1).toISOString()]);
  });

  it("pauses new invoices once a bill is past due, and resumes when it's paid", async () => {
    const existing = (await createInvoice()).json();
    const issuedAt = new Date(Date.now() - 20 * DAY);
    await ctx.db.update(merchants).set({ billingStartedAt: issuedAt }).where(eq(merchants.id, merchantId));
    await issueBills(ctx.db, ctx.config, issuedAt);

    // Due 14 days after issue: now past due.
    expect((await summary()).status).toBe("past_due");
    const blocked = await createInvoice();
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("billing_past_due");
    // Existing invoices still collect: the merchant's clients are never blocked.
    expect((await call(ctx.app, "GET", `/v1/checkout/${existing.id}`)).json().status).toBe("pending");

    const [period] = await ctx.db.select().from(billingPeriods);
    await payInvoice(period!.invoiceId);
    expect((await summary()).periods[0]!.status).toBe("paid");
    expect((await summary()).status).toBe("active");
    expect((await createInvoice()).statusCode).toBe(201);
  });

  it("treats a canceled bill as waived", async () => {
    const issuedAt = new Date(Date.now() - 20 * DAY);
    await ctx.db.update(merchants).set({ billingStartedAt: issuedAt }).where(eq(merchants.id, merchantId));
    await issueBills(ctx.db, ctx.config, issuedAt);
    const [period] = await ctx.db.select().from(billingPeriods);
    expect((await call(ctx.app, "POST", `/v1/invoices/${period!.invoiceId}/cancel`, { key: platformKey })).statusCode).toBe(200);
    expect((await summary()).periods[0]!.status).toBe("waived");
    expect((await createInvoice()).statusCode).toBe(201);
  });

  it("sends one reminder when a bill is within three days of its due date", async () => {
    const issuedAt = new Date(Date.now() - 12 * DAY);
    await ctx.db.update(merchants).set({ billingStartedAt: issuedAt }).where(eq(merchants.id, merchantId));
    await issueBills(ctx.db, ctx.config, issuedAt);
    expect(await sendBillingReminders(ctx.db, ctx.config, new Date(issuedAt.getTime() + 5 * DAY))).toBe(0);
    expect(await sendBillingReminders(ctx.db, ctx.config)).toBe(1);
    expect(await sendBillingReminders(ctx.db, ctx.config)).toBe(0);
    expect(await ctx.db.select().from(emailOutbox).where(eq(emailOutbox.template, "billing_reminder"))).toHaveLength(1);
  });

  it("does nothing when billing isn't configured", async () => {
    ctx.config.billing = null;
    await ctx.db.update(merchants).set({ billingStartedAt: new Date(Date.now() - 60 * DAY) }).where(eq(merchants.id, merchantId));
    expect(await issueBills(ctx.db, ctx.config)).toBe(0);
    expect(await summary()).toMatchObject({ enabled: false, status: "free", periods: [] });
    expect((await createInvoice()).statusCode).toBe(201);
  });
});
