import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { tokenInfo } from "@coinnew/chains";
import { partnerAccounts, partnerEvents, settlements, webhookDeliveries } from "@coinnew/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { verifyBridgeSignature } from "../src/rails/bridge.js";
import { signedWidgetUrl, verifyMoonPaySignature } from "../src/rails/moonpay.js";
import { processPartnerEvents } from "../src/services/partners.js";
import { FakeBridge } from "./fake-bridge.js";
import { call, EVM_WALLET, onboard, PAYER_EVM, setup, SOL_WALLET, type Ctx } from "./helpers.js";

// Test-only RSA pair standing in for Bridge's webhook signer.
// custody-guard-allow: test RSA key simulating a partner's webhook signature; not a wallet key
const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const BRIDGE_PUB = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
const MOONPAY = { publishableKey: "pk_test_1", urlSigningSecret: "sk_test_1", webhookKey: "wk_test_1", sandbox: true };

let ctx: Ctx;
let bridge: FakeBridge;
let key: string;

async function start(cfg: Partial<Config> = {}) {
  bridge = new FakeBridge();
  ctx = await setup({ bridge: { apiKey: "x", baseUrl: "https://bridge.test", webhookPublicKey: BRIDGE_PUB }, moonpay: MOONPAY, ...cfg }, { bridge });
  key = (await onboard(ctx.app, { receiving_wallets: { evm: EVM_WALLET, solana: SOL_WALLET } })).api_key.key;
  await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { webhook_url: "https://merchant.test/hooks" } });
}
beforeEach(() => start());
afterEach(() => ctx.close());

const partner = () => call(ctx.app, "GET", "/v1/merchants/me/partner", { key }).then((r) => r.json());
const ageAccount = () => ctx.db.update(partnerAccounts).set({ updatedAt: new Date(Date.now() - 120_000) });
async function approveMerchant(bank = true) {
  const s = (await call(ctx.app, "POST", "/v1/merchants/me/partner/onboarding", { key, body: {} })).json();
  bridge.approve([...bridge.links.keys()].at(-1)!);
  await ageAccount();
  if (bank) {
    const r = await call(ctx.app, "POST", "/v1/merchants/me/partner/bank-account", {
      key,
      body: { account_type: "us", bank_name: "Chase", account_owner_name: "Acme Ltd", account_number: "000123456789", routing_number: "021000021", address: { street_line_1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", country: "USA" } },
    });
    expect(r.statusCode).toBe(200);
  }
  return s;
}

const bridgeEvent = (payload: object) => {
  const body = JSON.stringify(payload);
  const t = String(Date.now());
  const sig = createSign("RSA-SHA256").update(`${t}.${body}`).sign(signer.privateKey, "base64"); // custody-guard-allow: test webhook signer, not a wallet key
  return ctx.app.inject({ method: "POST", url: "/internal/webhooks/bridge", headers: { "content-type": "application/json", "x-webhook-signature": `t=${t},v0=${sig}` }, payload: body });
};
const moonpayEvent = (payload: object, webhookKey = MOONPAY.webhookKey) => {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const s = createHmac("sha256", webhookKey).update(`${t}.${body}`).digest("hex");
  return ctx.app.inject({ method: "POST", url: "/internal/webhooks/moonpay", headers: { "content-type": "application/json", "moonpay-signature-v2": `t=${t},s=${s}` }, payload: body });
};
const newInvoice = async (body: Record<string, unknown> = {}) => (await call(ctx.app, "POST", "/v1/invoices", { key, body: { amount_usd: "2500.00", ...body } })).json();
const fiat = (id: string, body: object) => call(ctx.app, "POST", `/v1/checkout/${id}/fiat-session`, { idem: null, body });
const status = async (id: string) => (await call(ctx.app, "GET", `/v1/invoices/${id}`, { key })).json();
const events = async () => (await ctx.db.select().from(webhookDeliveries)).map((d) => d.eventType).sort();

describe("merchant KYB with the partner", () => {
  it("returns hosted KYB links and passes the partner's decision through", async () => {
    expect((await partner()).kyc_status).toBe("not_started");
    const s = await approveMerchant(false);
    expect(s).toMatchObject({ kyc_status: "not_started", kyc_link_url: expect.stringContaining("bridge.test/kyc"), payout_ready: false });
    // Starting again reuses the same link.
    await call(ctx.app, "POST", "/v1/merchants/me/partner/onboarding", { key, body: {} });
    expect(bridge.links.size).toBe(1);
    await ageAccount();
    expect(await partner()).toMatchObject({ kyc_status: "approved", tos_status: "approved", bank_account: null, payout_ready: false });
  });

  it("requires KYB before a bank account, and keeps only last 4 digits", async () => {
    const early = await call(ctx.app, "POST", "/v1/merchants/me/partner/bank-account", { key, body: { account_type: "iban", account_owner_name: "Acme", iban: "DE89370400440532013000", bic: "COBADEFFXXX", country: "DEU" } });
    expect(early.json().error.code).toBe("kyb_required");
    await approveMerchant();
    expect(await partner()).toMatchObject({ payout_ready: true, bank_account: { last4: "6789", rail: "ach", currency: "usd" } });
    const dump = JSON.stringify(await ctx.db.select().from(partnerAccounts));
    expect(dump).toContain("6789");
    expect(dump).not.toContain("000123456789");
  });

  it("enables fiat payout by provisioning liquidation addresses, skipping pairs the partner refuses", async () => {
    expect((await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { payout_preference: "fiat_via_partner" } })).json().error.code).toBe("partner_rail_required");
    await approveMerchant();
    bridge.unsupported.add("polygon:usdt");
    const r = await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { payout_preference: "fiat_via_partner" } });
    expect(r.json().payout_preference).toBe("fiat_via_partner");
    const liq = (await partner()).liquidation_addresses.map((l: { chain: string; token: string }) => `${l.chain}:${l.token}`).sort();
    expect(liq).toEqual(["base:USDC", "ethereum:USDC", "ethereum:USDT", "polygon:USDC", "solana:USDC", "solana:USDT"]);
  });

  it("never provisions Robinhood Chain under fiat payout, so checkout doesn't offer it", async () => {
    await approveMerchant();
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { preferred_chains: ["base", "robinhood"] } });
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { payout_preference: "fiat_via_partner" } });
    expect((await partner()).liquidation_addresses.map((l: { chain: string }) => l.chain)).toEqual(["base"]);
    const inv = await newInvoice({ accepted_chains: ["base", "robinhood"] });
    const opts = (await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json().payment_options;
    expect(opts.map((o: { chain: string }) => o.chain)).toEqual(["base"]);
  });

  it("routes crypto checkout to the liquidation address under fiat payout", async () => {
    await approveMerchant();
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { payout_preference: "fiat_via_partner" } });
    const inv = await newInvoice({ accepted_chains: ["base"] });
    const intent = (await call(ctx.app, "POST", `/v1/checkout/${inv.id}/onchain-intent`, { idem: null, body: { chain: "base", token: "USDC", payer_address: PAYER_EVM } })).json();
    const liq = (await partner()).liquidation_addresses.find((l: { chain: string }) => l.chain === "base").address;
    expect(intent.to_address).toBe(liq);
    expect(intent.to_address).not.toBe(EVM_WALLET);
  });
});

describe("buyer pays by bank transfer (Bridge)", () => {
  it("is offered only once the merchant is approved", async () => {
    const inv = await newInvoice();
    expect((await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json().fiat_methods).toEqual(["card"]);
    expect((await fiat(inv.id, { method: "bank_transfer" })).statusCode).toBe(422);
    await approveMerchant(false);
    expect((await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json().fiat_methods).toEqual(["bank_transfer", "card"]);
  });

  it("creates one transfer per invoice to the merchant's wallet and returns deposit instructions", async () => {
    await approveMerchant(false);
    const inv = await newInvoice();
    const res = await fiat(inv.id, { method: "bank_transfer", rail: "ach" });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s).toMatchObject({ method: "bank_transfer", rail: "bridge", status: "open", instructions: { amount: "2500.00", currency: "usd", reference: expect.stringMatching(/^BRG/), routing_number: "101019644" } });
    expect(bridge.transferCalls[0]!.input).toMatchObject({ amount: "2500.00", source: { payment_rail: "ach_push", currency: "usd" }, destination: { payment_rail: "base", currency: "usdc", to_address: EVM_WALLET } });
    expect(bridge.transferCalls[0]!.idem).toBe(s.id);
    // Same method again: same session, no second transfer.
    expect((await fiat(inv.id, { method: "bank_transfer", rail: "ach" })).json().id).toBe(s.id);
    expect(bridge.transferCalls).toHaveLength(1);
  });

  it("settles to the merchant's bank under fiat payout", async () => {
    await approveMerchant();
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key, body: { payout_preference: "fiat_via_partner" } });
    const inv = await newInvoice();
    await fiat(inv.id, { method: "bank_transfer" });
    expect(bridge.transferCalls[0]!.input.destination).toMatchObject({ payment_rail: "ach", currency: "usd", external_account_id: expect.stringMatching(/^ext_/) });
  });

  it("follows the transfer: funds received → processing, processed → paid (state re-read from Bridge)", async () => {
    await approveMerchant(false);
    const inv = await newInvoice();
    await fiat(inv.id, { method: "bank_transfer" });
    const tr = [...bridge.transfers.keys()][0]!;

    const bad = await ctx.app.inject({ method: "POST", url: "/internal/webhooks/bridge", headers: { "content-type": "application/json", "x-webhook-signature": `t=${Date.now()},v0=AAAA` }, payload: "{}" });
    expect(bad.statusCode).toBe(401);

    bridge.setState(tr, "funds_received");
    // The payload claims "payment_processed", but Bridge says funds_received: Bridge wins.
    await bridgeEvent({ event_id: "ev1", event_category: "transfer", event_type: "transfer.updated", event_object_id: tr, event_object_status: "payment_processed" });
    await processPartnerEvents(ctx.partners);
    expect((await status(inv.id)).status).toBe("processing");

    bridge.setState(tr, "payment_processed", { destination_tx_hash: "0xabc", final_amount: "2497.50" });
    await bridgeEvent({ event_id: "ev2", event_category: "transfer", event_object_id: tr });
    await processPartnerEvents(ctx.partners);
    const got = await status(inv.id);
    expect(got.status).toBe("paid");
    expect(got.settlements[0]).toMatchObject({ rail: "bridge", method: "bank_transfer", chain: "base", tx_hash: "0xabc", amount: "2497.5", token: "USDC", to_address: EVM_WALLET });
    expect(await events()).toEqual(["invoice.paid", "settlement.confirmed"]);

    // Duplicate delivery: stored once, no double settlement.
    await bridgeEvent({ event_id: "ev2", event_category: "transfer", event_object_id: tr });
    await processPartnerEvents(ctx.partners);
    expect(await ctx.db.select().from(settlements)).toHaveLength(1);
  });

  it("returns the invoice to pending when the transfer fails", async () => {
    await approveMerchant(false);
    const inv = await newInvoice();
    await fiat(inv.id, { method: "bank_transfer" });
    const tr = [...bridge.transfers.keys()][0]!;
    bridge.setState(tr, "funds_received");
    await bridgeEvent({ event_id: "a", event_category: "transfer", event_object_id: tr });
    await processPartnerEvents(ctx.partners);
    bridge.setState(tr, "returned");
    await bridgeEvent({ event_id: "b", event_category: "transfer", event_object_id: tr });
    await processPartnerEvents(ctx.partners);
    expect((await status(inv.id)).status).toBe("pending");
  });

  it("updates KYB status from kyc_link events", async () => {
    await call(ctx.app, "POST", "/v1/merchants/me/partner/onboarding", { key, body: {} });
    const id = [...bridge.links.keys()][0]!;
    bridge.approve(id);
    // No time has passed, so only the webhook can bring the decision in.
    await bridgeEvent({ event_id: "k1", event_category: "kyc_link", event_object: { id, kyc_status: "approved" } });
    await processPartnerEvents(ctx.partners);
    const [row] = await ctx.db.select().from(partnerEvents);
    expect(row!.processedAt).not.toBeNull();
    expect((await ctx.db.select().from(partnerAccounts))[0]).toMatchObject({ kycStatus: "approved", customerId: `cus_${id}` });
  });
});

describe("buyer pays by card (MoonPay)", () => {
  it("returns a signed widget URL for the exact amount to the merchant's address", async () => {
    const inv = await newInvoice({ amount_usd: "99.00" });
    const s = (await fiat(inv.id, { method: "card", chain: "base", token: "USDC" })).json();
    const url = new URL(s.redirect_url);
    expect(url.origin).toBe("https://buy-sandbox.moonpay.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ currencyCode: "usdc_base", walletAddress: EVM_WALLET, quoteCurrencyAmount: "99", lockAmount: "true", externalTransactionId: s.id });
    // Signature covers the query string before `signature` was appended.
    const sig = url.searchParams.get("signature");
    url.searchParams.delete("signature");
    expect(createHmac("sha256", MOONPAY.urlSigningSecret).update(url.search).digest("base64")).toBe(sig);
    expect(signedWidgetUrl(MOONPAY, { currencyCode: "usdc", walletAddress: "0x1", cryptoAmount: "1", externalTransactionId: "x", redirectUrl: "https://x" })).toContain("signature=");
  });

  it("settles only after the delivery is verified on-chain", async () => {
    const inv = await newInvoice({ amount_usd: "99.00" });
    const s = (await fiat(inv.id, { method: "card", chain: "base", token: "USDC" })).json();
    const USDC = tokenInfo("mainnet", "base", "USDC")!.address;
    const tx = `0x${"7".repeat(64)}`;
    const completed = { type: "transaction_updated", data: { id: "mp_1", status: "completed", externalTransactionId: s.id, cryptoTransactionId: tx, updatedAt: "1" } };

    expect((await moonpayEvent(completed, "wrong")).statusCode).toBe(401);
    expect((await moonpayEvent(completed)).statusCode).toBe(202);
    await processPartnerEvents(ctx.partners);
    // MoonPay says completed, but the chain doesn't show it yet: not paid.
    expect((await status(inv.id)).status).toBe("pending");

    ctx.chain.publish("base", tx, [{ logIndex: 0, tokenAddress: USDC, from: "0x00000000000000000000000000000000000000AA", to: EVM_WALLET, amountUnits: 99_000_000n }]);
    // Retries back off; move the event's next attempt to now.
    await ctx.db.update(partnerEvents).set({ nextAttemptAt: new Date() });
    await processPartnerEvents(ctx.partners);
    const got = await status(inv.id);
    expect(got.status).toBe("paid");
    expect(got.settlements[0]).toMatchObject({ rail: "moonpay", method: "card", tx_hash: tx, amount: "99" });
  });

  it("does not settle a short delivery", async () => {
    const inv = await newInvoice({ amount_usd: "99.00" });
    const s = (await fiat(inv.id, { method: "card", chain: "base", token: "USDC" })).json();
    const tx = `0x${"8".repeat(64)}`;
    ctx.chain.publish("base", tx, [{ logIndex: 0, tokenAddress: tokenInfo("mainnet", "base", "USDC")!.address, from: null, to: EVM_WALLET, amountUnits: 98_000_000n }]);
    await moonpayEvent({ type: "transaction_updated", data: { id: "mp_2", status: "completed", externalTransactionId: s.id, cryptoTransactionId: tx } });
    await processPartnerEvents(ctx.partners);
    expect((await status(inv.id)).status).toBe("pending");
  });

  it("is not offered when MoonPay isn't configured", async () => {
    await ctx.close();
    await start({ moonpay: null });
    const inv = await newInvoice();
    expect((await call(ctx.app, "GET", `/v1/checkout/${inv.id}`)).json().fiat_methods).toEqual([]);
    expect((await fiat(inv.id, { method: "card", chain: "base", token: "USDC" })).statusCode).toBe(422);
  });
});

describe("signature verification", () => {
  it("rejects stale Bridge timestamps and tampered bodies", () => {
    const body = '{"event_id":"x"}';
    const sign = (t: number, b: string) => createSign("RSA-SHA256").update(`${t}.${b}`).sign(signer.privateKey, "base64"); // custody-guard-allow: test webhook signer, not a wallet key
    const now = Date.now();
    expect(verifyBridgeSignature(`t=${now},v0=${sign(now, body)}`, body, BRIDGE_PUB, now)).toBe(true);
    expect(verifyBridgeSignature(`t=${now},v0=${sign(now, body)}`, body + " ", BRIDGE_PUB, now)).toBe(false);
    const old = now - 20 * 60_000;
    expect(verifyBridgeSignature(`t=${old},v0=${sign(old, body)}`, body, BRIDGE_PUB, now)).toBe(false);
  });

  it("rejects stale MoonPay timestamps", () => {
    const t = Math.floor(Date.now() / 1000) - 3600;
    const s = createHmac("sha256", "k").update(`${t}.{}`).digest("hex");
    expect(verifyMoonPaySignature(`t=${t},s=${s}`, "{}", "k")).toBe(false);
  });
});
