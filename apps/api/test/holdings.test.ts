import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HoldingsService } from "../src/services/holdings.js";
import { call, EVM_WALLET, FakeChain, onboard, setup, SOL_WALLET, type Ctx } from "./helpers.js";

const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".toLowerCase();

let ctx: Ctx;
beforeEach(async () => (ctx = await setup()));
afterEach(() => ctx.close());

const setBalance = (chain: string, token: string, owner: string, units: bigint | Error) =>
  ctx.chain.holdings.set(`${chain}:${token}:${owner.toLowerCase()}`, units);

describe("GET /v1/merchants/me/holdings", () => {
  it("reads every registry stablecoin in the merchant's wallets and totals them at par", async () => {
    const { api_key } = await onboard(ctx.app, { receiving_wallets: { evm: EVM_WALLET, solana: SOL_WALLET }, preferred_chains: ["base", "solana"] });
    setBalance("ethereum", USDC_ETH, EVM_WALLET, 37_192_124n);
    setBalance("ethereum", USDT_ETH, EVM_WALLET, 291_368_219n);
    setBalance("base", USDC_BASE, EVM_WALLET, 1_000_000n);
    setBalance("solana", USDC_SOL, SOL_WALLET, 5_509_999n);

    const res = await call(ctx.app, "GET", "/v1/merchants/me/holdings", { key: api_key.key });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ network: "mainnet", total_usd: "335.07", complete: true });
    // 7 mainnet stablecoins: USDC+USDT on ethereum/polygon/solana, USDC on base (no USDT on Base).
    expect(body.data).toHaveLength(7);
    expect(body.data.find((r: { chain: string; token: string }) => r.chain === "ethereum" && r.token === "USDT")).toMatchObject({
      balance: "291.368219",
      wallet: EVM_WALLET,
      accepting: false,
      error: null,
    });
    expect(body.data.find((r: { chain: string }) => r.chain === "base")).toMatchObject({ balance: "1", accepting: true });
    expect(body.data.find((r: { chain: string; token: string }) => r.chain === "polygon" && r.token === "USDC")).toMatchObject({ balance: "0" });
  });

  it("only queries chains the merchant has a wallet for", async () => {
    const { api_key } = await onboard(ctx.app, { receiving_wallets: { solana: SOL_WALLET } });
    const body = (await call(ctx.app, "GET", "/v1/merchants/me/holdings", { key: api_key.key })).json();
    expect(body.data.map((r: { chain: string }) => r.chain)).toEqual(["solana", "solana"]);
  });

  it("isolates a failing chain and marks the total incomplete", async () => {
    const { api_key } = await onboard(ctx.app);
    setBalance("ethereum", USDC_ETH, EVM_WALLET, 2_500_000n);
    setBalance("polygon", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", EVM_WALLET, new Error("rpc down"));

    const body = (await call(ctx.app, "GET", "/v1/merchants/me/holdings", { key: api_key.key })).json();
    expect(body).toMatchObject({ total_usd: "2.50", complete: false });
    const failed = body.data.find((r: { chain: string; token: string }) => r.chain === "polygon" && r.token === "USDC");
    expect(failed).toMatchObject({ balance: null, error: "Couldn't read Polygon right now" });
    expect(JSON.stringify(failed)).not.toContain("rpc down");
  });

  it("requires auth", async () => {
    expect((await call(ctx.app, "GET", "/v1/merchants/me/holdings")).statusCode).toBe(401);
  });
});

describe("HoldingsService", () => {
  const owner = { id: "m1", evmWallet: EVM_WALLET, solanaWallet: null, preferredChains: ["ethereum" as const] };

  it("caches for 30s, and re-reads when the wallet changes", async () => {
    const chain = new FakeChain();
    let reads = 0;
    const balance = chain.balance.bind(chain);
    chain.balance = async (...a) => (reads++, balance(...a));
    let t = 0;
    const svc = new HoldingsService(chain, "mainnet", () => t);

    await svc.get(owner);
    expect(reads).toBe(5);
    t = 29_000;
    await svc.get(owner);
    expect(reads).toBe(5);
    await svc.get({ ...owner, evmWallet: "0x2222222222222222222222222222222222222222" });
    expect(reads).toBe(10);
    t = 31_000;
    await svc.get(owner);
    expect(reads).toBe(15);
  });

  it("truncates the total to whole cents rather than rounding up", async () => {
    const chain = new FakeChain();
    chain.holdings.set(`ethereum:${USDC_ETH}:${EVM_WALLET.toLowerCase()}`, 1_999_999n);
    const res = await new HoldingsService(chain, "mainnet").get(owner);
    expect(res.total_usd).toBe("1.99");
  });
});
