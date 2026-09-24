import { idempotencyKeys } from "@coinnew/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onboard, setup, SOL_WALLET, EVM_WALLET, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeEach(async () => (ctx = await setup()));
afterEach(() => ctx.close());

describe("onboarding", () => {
  it("creates a merchant, normalises input and returns an API key once", async () => {
    const { merchant, api_key } = await onboard(ctx.app, { email: "Owner@Acme.TEST" });
    expect(merchant).toMatchObject({ email: "owner@acme.test", country_code: "AE", payout_preference: "crypto", preferred_chains: ["ethereum", "base", "polygon"] });
    expect(api_key.key).toMatch(/^cn_[0-9a-f]{32}_[\w-]{43}$/);
    expect(merchant).not.toHaveProperty("api_key_hash");
  });

  it("derives Solana-only chains from a Solana wallet", async () => {
    const { merchant } = await onboard(ctx.app, { default_receiving_wallet: SOL_WALLET });
    expect(merchant.preferred_chains).toEqual(["solana"]);
  });

  it("rejects chains the receiving wallet cannot receive on", async () => {
    const res = await call(ctx.app, "POST", "/v1/merchants", {
      body: { business_name: "X", email: "x@x.test", country_code: "US", default_receiving_wallet: EVM_WALLET, preferred_chains: ["base", "solana"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("chain_wallet_mismatch");
  });

  it("rejects invalid wallets and duplicate emails", async () => {
    const bad = await call(ctx.app, "POST", "/v1/merchants", { body: { business_name: "X", email: "x@x.test", country_code: "US", default_receiving_wallet: "not-a-wallet" } });
    expect(bad.statusCode).toBe(400);
    await onboard(ctx.app, { email: "dup@x.test" });
    const dup = await call(ctx.app, "POST", "/v1/merchants", { body: { business_name: "X", email: "dup@x.test", country_code: "US", default_receiving_wallet: EVM_WALLET } });
    expect(dup.statusCode).toBe(409);
  });
});

describe("idempotency", () => {
  const body = { business_name: "Idem", email: "idem@x.test", country_code: "US", default_receiving_wallet: EVM_WALLET };

  it("requires the header on mutating requests", async () => {
    const res = await call(ctx.app, "POST", "/v1/merchants", { body, idem: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("replays the original response without re-executing, and never stores the plaintext key", async () => {
    const first = await call(ctx.app, "POST", "/v1/merchants", { body, idem: "idem-key-0001" });
    const again = await call(ctx.app, "POST", "/v1/merchants", { body, idem: "idem-key-0001" });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().merchant.id).toBe(first.json().merchant.id);
    expect(again.json().api_key.key).toMatch(/redacted/);
    const stored = await ctx.db.select().from(idempotencyKeys);
    expect(JSON.stringify(stored)).not.toContain(first.json().api_key.key);
  });

  it("rejects a reused key with a different request", async () => {
    await call(ctx.app, "POST", "/v1/merchants", { body, idem: "idem-key-0002" });
    const res = await call(ctx.app, "POST", "/v1/merchants", { body: { ...body, business_name: "Other" }, idem: "idem-key-0002" });
    expect(res.statusCode).toBe(422);
  });

  it("scopes keys per merchant", async () => {
    const a = await onboard(ctx.app);
    const b = await onboard(ctx.app);
    const ra = await call(ctx.app, "POST", "/v1/invoices", { key: a.api_key.key, body: { amount_usd: 10 }, idem: "shared-key-01" });
    const rb = await call(ctx.app, "POST", "/v1/invoices", { key: b.api_key.key, body: { amount_usd: 10 }, idem: "shared-key-01" });
    expect(rb.statusCode).toBe(201);
    expect(rb.json().id).not.toBe(ra.json().id);
  });
});

describe("auth and API keys", () => {
  it("rejects missing, malformed and forged keys", async () => {
    const { api_key } = await onboard(ctx.app);
    expect((await call(ctx.app, "GET", "/v1/merchants/me")).statusCode).toBe(401);
    expect((await call(ctx.app, "GET", "/v1/merchants/me", { key: "nope" })).statusCode).toBe(401);
    const forged = api_key.key.slice(0, -4) + "AAAA";
    expect((await call(ctx.app, "GET", "/v1/merchants/me", { key: forged })).statusCode).toBe(401);
  });

  it("rotates and revokes keys, refusing to revoke the last one", async () => {
    const { api_key } = await onboard(ctx.app);
    const last = await call(ctx.app, "DELETE", `/v1/merchants/me/api-keys/${api_key.id}`, { key: api_key.key });
    expect(last.statusCode).toBe(409);

    const issued = await call(ctx.app, "POST", "/v1/merchants/me/api-keys", { key: api_key.key, body: { label: "ci" } });
    expect(issued.statusCode).toBe(201);
    const newKey = issued.json().key as string;

    const revoked = await call(ctx.app, "DELETE", `/v1/merchants/me/api-keys/${api_key.id}`, { key: newKey });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revoked_at).not.toBeNull();
    expect((await call(ctx.app, "GET", "/v1/merchants/me", { key: api_key.key })).statusCode).toBe(401);
    expect((await call(ctx.app, "GET", "/v1/merchants/me", { key: newKey })).statusCode).toBe(200);

    const list = await call(ctx.app, "GET", "/v1/merchants/me/api-keys", { key: newKey });
    expect(list.json().data).toHaveLength(2);
    expect(JSON.stringify(list.json())).not.toContain("key_hash");
  });

  it("cannot revoke another merchant's key", async () => {
    const a = await onboard(ctx.app);
    const b = await onboard(ctx.app);
    await call(ctx.app, "POST", "/v1/merchants/me/api-keys", { key: a.api_key.key, body: {} });
    const res = await call(ctx.app, "DELETE", `/v1/merchants/me/api-keys/${a.api_key.id}`, { key: b.api_key.key });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /v1/merchants/me", () => {
  it("updates webhook and wallet, re-deriving chains on a family switch", async () => {
    const { api_key } = await onboard(ctx.app);
    const res = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: api_key.key, body: { webhook_url: "https://acme.test/hooks", default_receiving_wallet: SOL_WALLET } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ webhook_url: "https://acme.test/hooks", default_receiving_wallet: SOL_WALLET, preferred_chains: ["solana"] });
  });

  it("rejects plain-http webhooks and gates fiat payout behind a partner rail", async () => {
    const { api_key } = await onboard(ctx.app);
    expect((await call(ctx.app, "PATCH", "/v1/merchants/me", { key: api_key.key, body: { webhook_url: "http://acme.test/h" } })).statusCode).toBe(400);
    const fiat = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: api_key.key, body: { payout_preference: "fiat_via_partner" } });
    expect(fiat.statusCode).toBe(422);
    expect(fiat.json().error.code).toBe("partner_rail_required");
  });
});
