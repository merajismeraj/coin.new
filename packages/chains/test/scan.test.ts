import { pad, toEventSelector } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcChainVerifier } from "../src/verify/index.js";

const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TO = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

/** Fake JSON-RPC endpoint: records methods, answers by method name. */
function stubRpc(answer: (method: string, params: unknown[]) => unknown) {
  const calls: { method: string; params: unknown[] }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const reqs = [JSON.parse(init.body)].flat() as { id: number; method: string; params: unknown[] }[];
    const out = reqs.map(({ id, method, params }) => {
      calls.push({ method, params });
      const r = answer(method, params);
      return r instanceof Error ? { jsonrpc: "2.0", id, error: { code: -32600, message: r.message } } : { jsonrpc: "2.0", id, result: r };
    });
    return new Response(JSON.stringify(Array.isArray(JSON.parse(init.body)) ? out : out[0]), { headers: { "content-type": "application/json" } });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("fallback scan", () => {
  it("uses Alchemy's transfers index from the intent's start block, however far back", async () => {
    const calls = stubRpc((m) => (m === "eth_blockNumber" ? "0x100000" : m === "alchemy_getAssetTransfers" ? { transfers: [{ hash: HASH }, { hash: HASH }] } : new Error(`unexpected ${m}`)));
    const v = new RpcChainVerifier({ network: "mainnet", rpcUrls: { ethereum: "https://eth-mainnet.g.alchemy.com/v2/k" } });

    expect(await v.scan("ethereum", { tokenAddress: TOKEN, to: TO, fromBlock: 0x10n })).toEqual([HASH]);
    const req = calls.find((c) => c.method === "alchemy_getAssetTransfers")!.params[0];
    expect(req).toMatchObject({ fromBlock: "0x10", toAddress: TO, contractAddresses: [TOKEN], category: ["erc20"] });
    expect(calls.some((c) => c.method === "eth_getLogs")).toBe(false);
  });

  it("falls back to eth_getLogs when the transfers index is unavailable", async () => {
    const calls = stubRpc((m) =>
      m === "eth_blockNumber" ? "0x100000" : m === "eth_getLogs" ? [{ transactionHash: HASH, blockNumber: "0x1", logIndex: "0x0", address: TOKEN, data: pad("0x01"), topics: [toEventSelector("Transfer(address,address,uint256)"), pad(TO), pad(TO)] }] : new Error("method not supported"),
    );
    const v = new RpcChainVerifier({ network: "mainnet", rpcUrls: { ethereum: "https://eth-mainnet.g.alchemy.com/v2/k" } });
    expect(await v.scan("ethereum", { tokenAddress: TOKEN, to: TO, fromBlock: null })).toEqual([HASH]);
    expect(calls.map((c) => c.method)).toContain("eth_getLogs");
  });

  it("uses bounded eth_getLogs directly on other providers", async () => {
    const calls = stubRpc((m) => (m === "eth_blockNumber" ? "0x100000" : m === "eth_getLogs" ? [] : new Error(`unexpected ${m}`)));
    const v = new RpcChainVerifier({ network: "mainnet", rpcUrls: { ethereum: "https://rpc.example.com" } });
    await v.scan("ethereum", { tokenAddress: TOKEN, to: TO, fromBlock: 0x10n });
    expect(calls.map((c) => c.method)).not.toContain("alchemy_getAssetTransfers");
    // Floored to the last 5,000 blocks.
    expect(calls.find((c) => c.method === "eth_getLogs")!.params[0]).toMatchObject({ fromBlock: `0x${(0x100000 - 5000).toString(16)}` });
  });
});
