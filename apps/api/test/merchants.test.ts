import { idempotencyKeys } from "@coinnew/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, onboard, setup, SOL_WALLET, EVM_WALLET, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeEach(async () => (ctx = await setup()));
afterEach(() => ctx.close());

describe("onboarding", () => {
  it("creates a merchant, normalises input and returns an API key once", async () => {
    const { merchant, api_key } = await onboard(ctx.app, { email: "Owner@Acme.TEST" });
    expect(merchant).toMatchObject({ email: "owner@acme.test", country_code: "GB", payout_preference: "crypto", preferred_chains: ["ethereum", "base", "polygon"] });
    expect(api_key.key).toMatch(/^cn_[0-9a-f]{32}_[\w-]{43}$/);
    expect(merchant).not.toHaveProperty("api_key_hash");
  });

  it("derives chains from the wallets provided", async () => {
    expect((await onboard(ctx.app, { receiving_wallets: { solana: SOL_WALLET } })).merchant.preferred_chains).toEqual(["solana"]);
    const both = await onboard(ctx.app, { receiving_wallets: { evm: EVM_WALLET.toLowerCase(), solana: SOL_WALLET } });
    expect(both.merchant.preferred_chains).toEqual(["ethereum", "base", "polygon", "solana"]);
    expect(both.merchant.receiving_wallets).toEqual({ evm: EVM_WALLET, solana: SOL_WALLET });
  });

  it("rejects chains without a wallet of their family", async () => {
    const res = await call(ctx.app, "POST", "/v1/merchants", {
      body: { business_name: "X", email: "x@x.test", country_code: "US", receiving_wallets: { evm: EVM_WALLET }, preferred_chains: ["base", "solana"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("chain_wallet_mismatch");
  });

  it("rejects wrong-family addresses, missing wallets and duplicate emails", async () => {
    const base = { business_name: "X", email: "x@x.test", country_code: "US" };
    expect((await call(ctx.app, "POST", "/v1/merchants", { body: { ...base, receiving_wallets: { evm: SOL_WALLET } } })).statusCode).toBe(400);
    expect((await call(ctx.app, "POST", "/v1/merchants", { body: { ...base, receiving_wallets: {} } })).statusCode).toBe(400);
    // One flipped case in a checksummed address = typo.
    const typo = await call(ctx.app, "POST", "/v1/merchants", { body: { ...base, receiving_wallets: { evm: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".replace("fCD", "fcD") } } });
    expect(typo.json().error.details[0].message).toMatch(/checksum/);
    await onboard(ctx.app, { email: "dup@x.test" });
    const dup = await call(ctx.app, "POST", "/v1/merchants", { body: { ...base, email: "dup@x.test", receiving_wallets: { evm: EVM_WALLET } } });
    expect(dup.statusCode).toBe(409);
  });
});

describe("idempotency", () => {
  const body = { business_name: "Idem", email: "idem@x.test", country_code: "US", receiving_wallets: { evm: EVM_WALLET } };

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
  it("adding a wallet family enables its chains; removing one disables them", async () => {
    const { api_key } = await onboard(ctx.app);
    const k = api_key.key;
    await call(ctx.app, "PATCH", "/v1/merchants/me", { key: k, body: { preferred_chains: ["base"] } });
    const added = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: k, body: { webhook_url: "https://acme.test/hooks", receiving_wallets: { solana: SOL_WALLET } } });
    expect(added.json()).toMatchObject({ webhook_url: "https://acme.test/hooks", preferred_chains: ["base", "solana"], receiving_wallets: { evm: EVM_WALLET, solana: SOL_WALLET } });
    const removed = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: k, body: { receiving_wallets: { evm: null } } });
    expect(removed.json()).toMatchObject({ preferred_chains: ["solana"], receiving_wallets: { evm: null, solana: SOL_WALLET } });
    const none = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: k, body: { receiving_wallets: { solana: null } } });
    expect(none.json().error.code).toBe("wallet_required");
  });

  it("exposes and rotates the webhook signing secret", async () => {
    const { api_key } = await onboard(ctx.app);
    const first = (await call(ctx.app, "GET", "/v1/merchants/me/webhook-secret", { key: api_key.key })).json().secret;
    expect(first).toMatch(/^whsec_/);
    const rotated = (await call(ctx.app, "POST", "/v1/merchants/me/webhook-secret/rotate", { key: api_key.key })).json().secret;
    expect(rotated).not.toBe(first);
    expect((await call(ctx.app, "GET", "/v1/merchants/me/webhook-secret", { key: api_key.key })).json().secret).toBe(rotated);
  });

  it("rejects plain-http webhooks and gates fiat payout behind a partner rail", async () => {
    const { api_key } = await onboard(ctx.app);
    expect((await call(ctx.app, "PATCH", "/v1/merchants/me", { key: api_key.key, body: { webhook_url: "http://acme.test/h" } })).statusCode).toBe(400);
    const fiat = await call(ctx.app, "PATCH", "/v1/merchants/me", { key: api_key.key, body: { payout_preference: "fiat_via_partner" } });
    expect(fiat.statusCode).toBe(422);
    expect(fiat.json().error.code).toBe("partner_rail_required");
  });
});
