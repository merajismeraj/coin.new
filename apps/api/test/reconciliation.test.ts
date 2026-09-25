import { createHash } from "node:crypto";
import { tokenInfo } from "@coinnew/chains";
import { emailOutbox, idempotencyKeys, inboundEvents, invoices, settlements, webhookDeliveries } from "@coinnew/db";
import type { OnchainIntent } from "@coinnew/shared-types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvCell } from "../src/lib/csv.js";
import { deliverEmails, type EmailSender } from "../src/services/email.js";
import { expireInvoices, sendExpiryReminders } from "../src/services/jobs.js";
import { processInboundEvents } from "../src/services/payments.js";
import { deliverDueWebhooks } from "../src/services/webhooks.js";
import { call, EVM_WALLET, onboard, PAYER_EVM, setup, type Ctx } from "./helpers.js";

let ctx: Ctx;
let key: string;
beforeEach(async () => {
  ctx = await setup();
  key = (await onboard(ctx.app, { business_name: 'Acme <script>alert(1)</script> & Co' })).api_key.key;
  await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { webhook_url: "https://merchant.test/hooks" } });
});
afterEach(() => ctx.close());

const USDC = tokenInfo("mainnet", "base", "USDC")!.address;
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const newInvoice = async (body: Record<string, unknown> = {}, k = key) => (await call(ctx.app, "POST", "/v1/invoices", { key: k, body: { amount_usd: "500.00", ...body } })).json();
const emails = async () => ctx.db.select().from(emailOutbox);

/** Pays an invoice on the fake chain and processes it. */
async function payInvoice(invId: string, tx: string) {
  const i = (await call(ctx.app, "POST", `/v1/checkout/${invId}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } })).json() as OnchainIntent;
  ctx.chain.publish("base", tx, [{ logIndex: 0, tokenAddress: USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: BigInt(i.amount_units) }]);
  await ctx.db.insert(inboundEvents).values({ source: "alchemy", chain: "base", txHash: tx, payload: {} });
  await processInboundEvents(ctx.payments);
  return i;
}

describe("email notifications", () => {
  it("emails the buyer on invoice creation, with merchant-controlled text escaped", async () => {
    const inv = await newInvoice({ buyer_email: "ap@buyer.test", invoice_number: "INV-<b>7</b>" });
    const [e] = await emails();
    expect(e).toMatchObject({ template: "invoice_issued", toAddress: "ap@buyer.test", invoiceId: inv.id, status: "pending" });
    expect(e!.html).toContain(inv.checkout_url);
    expect(e!.html).not.toContain("<script>");
    expect(e!.html).toContain("&lt;script&gt;");
    expect(e!.html).not.toContain("<b>7</b>");
    expect(e!.subject).not.toMatch(/[\r\n]/);
  });

  it("respects notify_buyer=false and skips invoices without a buyer email", async () => {
    await newInvoice({ buyer_email: "ap@buyer.test", notify_buyer: false });
    await newInvoice();
    expect(await emails()).toHaveLength(0);
  });

  it("throttles resends", async () => {
    const inv = await newInvoice({ buyer_email: "ap@buyer.test" });
    const again = await call(ctx.app, "POST", `/v1/invoices/${inv.id}/resend`, { key });
    expect(again.statusCode).toBe(429);
    await ctx.db.update(emailOutbox).set({ createdAt: new Date(Date.now() - 11 * 60_000) });
    expect((await call(ctx.app, "POST", `/v1/invoices/${inv.id}/resend`, { key })).json()).toEqual({ sent_to: "ap@buyer.test" });
    const noEmail = await newInvoice();
    expect((await call(ctx.app, "POST", `/v1/invoices/${noEmail.id}/resend`, { key })).json().error.code).toBe("no_buyer_email");
  });

  it("sends a receipt to the buyer and a notification to the merchant on payment", async () => {
    const inv = await newInvoice({ buyer_email: "ap@buyer.test", notify_buyer: false });
    await payInvoice(inv.id, TX(1));
    const me = (await call(ctx.app, "GET", "/v1/merchants/me", { key })).json();
    const e = await emails();
    expect(e.map((x) => `${x.template}:${x.toAddress}`).sort()).toEqual(["payment_receipt:ap@buyer.test", `payment_received_merchant:${me.email}`]);
    expect(e.find((x) => x.template === "payment_receipt")!.html).toContain(`https://basescan.org/tx/${TX(1)}`);
  });

  it("delivers the outbox with the row id as provider idempotency key, retrying failures", async () => {
    await newInvoice({ buyer_email: "ap@buyer.test" });
    const sent: { to: string; idempotencyKey: string }[] = [];
    let fail = true;
    const sender: EmailSender = {
      async send(m) {
        if (fail) throw new Error("provider down");
        sent.push({ to: m.to, idempotencyKey: m.idempotencyKey });
        return { id: "re_123" };
      },
    };
    await deliverEmails(ctx.db, sender, "billing@coin.test");
    let [e] = await emails();
    expect(e).toMatchObject({ status: "pending", attempts: 1, lastError: "provider down" });
    fail = false;
    await ctx.db.update(emailOutbox).set({ nextAttemptAt: new Date() });
    await deliverEmails(ctx.db, sender, "billing@coin.test");
    [e] = await emails();
    expect(e).toMatchObject({ status: "sent", attempts: 2, providerId: "re_123" });
    expect(sent).toEqual([{ to: "ap@buyer.test", idempotencyKey: e!.id }]);
  });
});

describe("expiry jobs", () => {
  it("persists expiry and emits invoice.expired exactly once", async () => {
    const inv = await newInvoice({ expires_in_hours: 1 });
    await ctx.db.update(invoices).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invoices.id, inv.id));
    await Promise.all([expireInvoices(ctx.db), expireInvoices(ctx.db)]);
    await expireInvoices(ctx.db);
    const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row!.status).toBe("expired");
    const hooks = (await ctx.db.select().from(webhookDeliveries)).filter((d) => d.eventType === "invoice.expired");
    expect(hooks).toHaveLength(1);
  });

  it("reminds the buyer once, only for invoices open long before the reminder window", async () => {
    const long = await newInvoice({ buyer_email: "a@b.test", expires_in_hours: 72, notify_buyer: false });
    const short = await newInvoice({ buyer_email: "c@d.test", expires_in_hours: 20, notify_buyer: false });
    expect(await sendExpiryReminders(ctx.db)).toBe(0);
    await ctx.db.update(invoices).set({ createdAt: new Date(Date.now() - 60 * 3600_000), expiresAt: new Date(Date.now() + 12 * 3600_000) }).where(eq(invoices.id, long.id));
    expect(await sendExpiryReminders(ctx.db)).toBe(1);
    expect(await sendExpiryReminders(ctx.db)).toBe(0);
    const e = await emails();
    expect(e.map((x) => x.template)).toEqual(["invoice_reminder"]);
    expect(e[0]!.toAddress).toBe("a@b.test");
    expect(e.some((x) => x.invoiceId === short.id)).toBe(false);
  });
});

describe("settlements API and CSV export", () => {
  it("lists settlements with filters, paging and merchant isolation", async () => {
    for (let n = 1; n <= 3; n++) await payInvoice((await newInvoice()).id, TX(10 + n));
    const p1 = (await call(ctx.app, "GET", "/v1/settlements?limit=2", { key })).json();
    const p2 = (await call(ctx.app, "GET", `/v1/settlements?limit=2&cursor=${p1.next_cursor}`, { key })).json();
    expect([...p1.data, ...p2.data].map((s: { invoice_number: string }) => s.invoice_number)).toEqual(["INV-00003", "INV-00002", "INV-00001"]);
    expect(p1.data[0]).toMatchObject({ rail: "onchain", method: null, invoice_amount_usd: "500.00", token: "USDC" });
    expect((await call(ctx.app, "GET", "/v1/settlements?rail=bridge", { key })).json().data).toHaveLength(0);
    const other = (await onboard(ctx.app)).api_key.key;
    expect((await call(ctx.app, "GET", "/v1/settlements", { key: other })).json().data).toHaveLength(0);
  });

  it("exports accountant-ready CSV with formula-injection protection", async () => {
    const inv = await newInvoice({ invoice_number: "=HYPERLINK(\"http://evil\")", buyer_email: "ap@buyer.test", notify_buyer: false, metadata: { po: "+SUM(A1)" } });
    await payInvoice(inv.id, TX(20));
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const res = await call(ctx.app, "GET", `/v1/reports/export?format=csv&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { key });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="coinnew-settlements-/);
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toBe("confirmed_at,invoice_number,invoice_id,invoice_amount_usd,invoice_status,buyer_email,rail,method,chain,token,amount,tx_hash,from_address,to_address,risk_flags,settlement_id,metadata");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[1]).toContain("ap@buyer.test");
    expect(lines[1]).toContain(TX(20));

    const bad = await call(ctx.app, "GET", `/v1/reports/export?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`, { key });
    expect(bad.json().error.code).toBe("invalid_range");
    const huge = await call(ctx.app, "GET", `/v1/reports/export?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`, { key });
    expect(huge.json().error.code).toBe("range_too_large");
  });

  it("csvCell guards formulas but leaves plain negatives and text alone", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
  });
});

describe("unmatched transfers", () => {
  async function wrongAmountPayment(tx: string, final = true) {
    ctx.chain.publish("base", tx, [{ logIndex: 2, tokenAddress: USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: 497_500_000n }], final);
    await ctx.db.insert(inboundEvents).values({ source: "alchemy", chain: "base", txHash: tx, payload: {} });
    await processInboundEvents(ctx.payments);
  }

  it("records transfers to a merchant address that match no intent", async () => {
    await newInvoice();
    await wrongAmountPayment(TX(30));
    // Transfers to unknown addresses or of unsupported tokens are ignored.
    ctx.chain.publish("base", TX(31), [
      { logIndex: 0, tokenAddress: USDC, from: PAYER_EVM, to: PAYER_EVM, amountUnits: 1n },
      { logIndex: 1, tokenAddress: "0x9999999999999999999999999999999999999999", from: PAYER_EVM, to: EVM_WALLET, amountUnits: 1n },
    ]);
    await ctx.db.insert(inboundEvents).values({ source: "alchemy", chain: "base", txHash: TX(31), payload: {} });
    await processInboundEvents(ctx.payments);

    const list = (await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ chain: "base", tx_hash: TX(30), token: "USDC", amount: "497.5", status: "open", explorer_url: `https://basescan.org/tx/${TX(30)}` });
  });

  it("assigns an unmatched transfer to an invoice after re-verifying it on-chain", async () => {
    const inv = await newInvoice({ buyer_email: "ap@buyer.test", notify_buyer: false });
    await wrongAmountPayment(TX(32), false);
    const [u] = (await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data;

    const early = await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/assign`, { key, body: { invoice_id: inv.id } });
    expect(early.json().error.code).toBe("not_final");

    ctx.chain.finalize("base", TX(32));
    const res = await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/assign`, { key, body: { invoice_id: inv.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amount: "497.5", risk_flags: ["manual_match"], invoice_id: inv.id });
    const got = (await call(ctx.app, "GET", `/v1/invoices/${inv.id}`, { key })).json();
    expect(got.status).toBe("paid");
    expect((await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data).toHaveLength(0);
    expect((await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/assign`, { key, body: { invoice_id: inv.id } })).statusCode).toBe(409);
  });

  it("dismisses, and isolates merchants", async () => {
    await wrongAmountPayment(TX(33));
    const [u] = (await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data;
    const other = (await onboard(ctx.app)).api_key.key;
    expect((await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/dismiss`, { key: other })).statusCode).toBe(404);
    expect((await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/dismiss`, { key })).json().status).toBe("dismissed");
    expect((await call(ctx.app, "GET", "/v1/unmatched-transfers?status=dismissed", { key })).json().data).toHaveLength(1);
  });
});

describe("hardening", () => {
  it("processes each inbound event once even with concurrent workers", async () => {
    const inv = await newInvoice();
    const i = (await call(ctx.app, "POST", `/v1/checkout/${inv.id}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } })).json();
    ctx.chain.publish("base", TX(40), [{ logIndex: 0, tokenAddress: USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: BigInt(i.amount_units) }]);
    await ctx.db.insert(inboundEvents).values({ source: "alchemy", chain: "base", txHash: TX(40), payload: {} });
    ctx.chain.calls = 0;
    const [a, b] = await Promise.all([processInboundEvents(ctx.payments), processInboundEvents(ctx.payments)]);
    expect(a + b).toBe(1);
    expect(ctx.chain.calls).toBe(1);
    expect(await ctx.db.select().from(settlements)).toHaveLength(1);
  });

  it("delivers each merchant webhook once with concurrent workers", async () => {
    const inv = await newInvoice();
    await call(ctx.app, "POST", `/v1/invoices/${inv.id}/cancel`, { key });
    let hits = 0;
    const fetchImpl = (async () => {
      hits++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await Promise.all([
      deliverDueWebhooks(ctx.db, { allowPrivateTargets: true, fetchImpl }),
      deliverDueWebhooks(ctx.db, { allowPrivateTargets: true, fetchImpl }),
    ]);
    expect(hits).toBe(1);
  });

  it("lets a retry take over an abandoned in-flight idempotency key", async () => {
    const m = (await call(ctx.app, "GET", "/v1/merchants/me", { key })).json();
    const body = { amount_usd: "5" };
    const hash = createHash("sha256").update(`POST /v1/invoices /v1/invoices\n${JSON.stringify(body)}`).digest("hex");
    await ctx.db.insert(idempotencyKeys).values({ scope: m.id, key: "crashed-req-1", requestHash: hash, createdAt: new Date(Date.now() - 5 * 60_000) });
    const res = await call(ctx.app, "POST", "/v1/invoices", { key, body, idem: "crashed-req-1" });
    expect(res.statusCode).toBe(201);
    // A fresh in-flight row still blocks.
    await ctx.db.insert(idempotencyKeys).values({ scope: m.id, key: "live-req-1", requestHash: hash });
    expect((await call(ctx.app, "POST", "/v1/invoices", { key, body, idem: "live-req-1" })).json().error.code).toBe("idempotency_in_progress");
  });
});

describe("flags", () => {
  it("does not mark a manual match as a risk in the merchant email", async () => {
    const inv = await newInvoice({ notify_buyer: false });
    ctx.chain.publish("base", TX(50), [{ logIndex: 0, tokenAddress: USDC, from: PAYER_EVM, to: EVM_WALLET, amountUnits: 499_000_000n }]);
    await ctx.db.insert(inboundEvents).values({ source: "alchemy", chain: "base", txHash: TX(50), payload: {} });
    await processInboundEvents(ctx.payments);
    const [u] = (await call(ctx.app, "GET", "/v1/unmatched-transfers", { key })).json().data;
    await call(ctx.app, "POST", `/v1/unmatched-transfers/${u.id}/assign`, { key, body: { invoice_id: inv.id } });
    const [mail] = (await emails()).filter((e) => e.template === "payment_received_merchant");
    expect(mail!.subject).not.toContain("[Review]");
    expect(mail!.html).not.toContain("Flagged");
  });
});
