import { invoices } from "@coinnew/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onboard, setup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let key: string;
beforeEach(async () => {
  ctx = await setup();
  key = (await onboard(ctx.app)).api_key.key;
});
afterEach(() => ctx.close());

const create = (body: Record<string, unknown>, k = key) => call(ctx.app, "POST", "/v1/invoices", { key: k, body });

describe("POST /v1/invoices", () => {
  it("creates the spec example invoice", async () => {
    const res = await create({ amount_usd: 1200.0, accepted_tokens: ["USDC", "USDT"], accepted_chains: ["base", "polygon"], buyer_email: "buyer@x.com", expires_in_hours: 72, metadata: { po_number: "PO-1029" } });
    expect(res.statusCode).toBe(201);
    const inv = res.json();
    expect(inv).toMatchObject({ invoice_number: "INV-00001", amount_usd: "1200.00", status: "pending", accepted_chains: ["base", "polygon"], metadata: { po_number: "PO-1029" } });
    expect(inv.checkout_url).toBe(`https://pay.test/i/${inv.id}`);
    expect(new Date(inv.expires_at).getTime() - Date.now()).toBeGreaterThan(71.9 * 3600_000);
  });

  it("numbers invoices sequentially and defaults chains/tokens from the merchant", async () => {
    await create({ amount_usd: "1" });
    const second = (await create({ amount_usd: "2.5" })).json();
    expect(second).toMatchObject({ invoice_number: "INV-00002", amount_usd: "2.50", accepted_tokens: ["USDC", "USDT"], accepted_chains: ["ethereum", "base", "polygon"] });
  });

  it("validates amounts, chains and custom invoice numbers", async () => {
    for (const amount_usd of [0, -5, "1.001", 0.1 + 0.2, "abc"]) expect((await create({ amount_usd })).statusCode).toBe(400);
    expect((await create({ amount_usd: 5, accepted_chains: ["solana"] })).json().error.code).toBe("chain_not_enabled");
    expect((await create({ amount_usd: 5, accepted_chains: ["base"], accepted_tokens: ["USDT"] })).json().error.code).toBe("no_payment_option");
    expect((await create({ amount_usd: 5, invoice_number: "A-1" })).statusCode).toBe(201);
    expect((await create({ amount_usd: 5, invoice_number: "A-1" })).statusCode).toBe(409);
  });
});

describe("reading invoices", () => {
  it("isolates merchants from each other", async () => {
    const inv = (await create({ amount_usd: 5 })).json();
    const other = (await onboard(ctx.app)).api_key.key;
    expect((await call(ctx.app, "GET", `/v1/invoices/${inv.id}`, { key: other })).statusCode).toBe(404);
    expect((await call(ctx.app, "GET", "/v1/invoices", { key: other })).json().data).toHaveLength(0);
  });

  it("returns settlements with the invoice", async () => {
    const inv = (await create({ amount_usd: 5 })).json();
    const res = await call(ctx.app, "GET", `/v1/invoices/${inv.id}`, { key });
    expect(res.json()).toMatchObject({ id: inv.id, settlements: [] });
  });

  it("paginates newest-first with a cursor and filters by status", async () => {
    for (let i = 0; i < 5; i++) await create({ amount_usd: i + 1 });
    const p1 = (await call(ctx.app, "GET", "/v1/invoices?limit=2", { key })).json();
    const p2 = (await call(ctx.app, "GET", `/v1/invoices?limit=2&cursor=${p1.next_cursor}`, { key })).json();
    const p3 = (await call(ctx.app, "GET", `/v1/invoices?limit=2&cursor=${p2.next_cursor}`, { key })).json();
    const numbers = [...p1.data, ...p2.data, ...p3.data].map((i: { invoice_number: string }) => i.invoice_number);
    expect(numbers).toEqual(["INV-00005", "INV-00004", "INV-00003", "INV-00002", "INV-00001"]);
    expect(p3.next_cursor).toBeNull();

    await call(ctx.app, "POST", `/v1/invoices/${p1.data[0].id}/cancel`, { key });
    const canceled = (await call(ctx.app, "GET", "/v1/invoices?status=canceled", { key })).json();
    expect(canceled.data.map((i: { id: string }) => i.id)).toEqual([p1.data[0].id]);
  });

  it("reports past-due pending invoices as expired, in reads and filters", async () => {
    const inv = (await create({ amount_usd: 5, expires_in_hours: 1 })).json();
    await ctx.db.update(invoices).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invoices.id, inv.id));
    expect((await call(ctx.app, "GET", `/v1/invoices/${inv.id}`, { key })).json().status).toBe("expired");
    expect((await call(ctx.app, "GET", "/v1/invoices?status=expired", { key })).json().data).toHaveLength(1);
    expect((await call(ctx.app, "GET", "/v1/invoices?status=pending", { key })).json().data).toHaveLength(0);
    expect((await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key })).statusCode).toBe(409);
  });
});

describe("POST /v1/invoices/:id/cancel", () => {
  it("cancels a pending invoice once", async () => {
    const inv = (await create({ amount_usd: 5 })).json();
    const res = await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    expect(res.json().status).toBe("canceled");
    expect((await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key })).statusCode).toBe(409);
  });
});

describe("GET /v1/checkout/:invoice_id (public)", () => {
  it("exposes only what checkout needs — no merchant email or buyer PII", async () => {
    const inv = (await create({ amount_usd: 99, buyer_email: "buyer@x.com" })).json();
    const res = await call(ctx.app, "GET", `/v1/checkout/${inv.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: inv.id,
      invoice_number: "INV-00001",
      merchant_name: "Acme Ltd",
      amount_usd: "99.00",
      accepted_tokens: ["USDC", "USDT"],
      accepted_chains: ["ethereum", "base", "polygon"],
      status: "pending",
      expires_at: null,
      payment: null,
      payment_options: expect.any(Array),
      fiat_methods: [],
    });
    // No USDT on Base: only official issuances are offered.
    expect(res.json().payment_options.map((o: { chain: string; token: string }) => `${o.chain}:${o.token}`)).toEqual([
      "ethereum:USDC", "ethereum:USDT", "base:USDC", "polygon:USDC", "polygon:USDT",
    ]);
  });

  it("404s for unknown or malformed ids", async () => {
    expect((await call(ctx.app, "GET", "/v1/checkout/00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
    expect((await call(ctx.app, "GET", "/v1/checkout/nope")).statusCode).toBe(404);
  });
});

describe("rate limiting", () => {
  it("limits writes per merchant", async () => {
    await ctx.close();
    ctx = await setup({ rateLimit: { enabled: true, readsPerMinute: 1000, writesPerMinute: 2 } });
    const k = (await onboard(ctx.app)).api_key.key;
    expect((await create({ amount_usd: 1 }, k)).statusCode).toBe(201);
    expect((await create({ amount_usd: 1 }, k)).statusCode).toBe(201);
    const limited = await create({ amount_usd: 1 }, k);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
  });
});
