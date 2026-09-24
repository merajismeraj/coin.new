import { encodeAbiParameters, pad, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { formatUnits, maxSuffix, supportedPairs, tokenInfo, usdToUnits } from "../src/index.js";
import { extractEvmTransfers, extractSolanaTransfers } from "../src/verify/index.js";

describe("registry", () => {
  it("has no USDT on Base and no USDT on testnets", () => {
    expect(tokenInfo("mainnet", "base", "USDT")).toBeUndefined();
    expect(supportedPairs("testnet", ["ethereum", "base", "polygon", "solana"], ["USDT"])).toEqual([]);
    expect(supportedPairs("mainnet", ["base", "polygon"], ["USDC", "USDT"]).map((t) => `${t.chain}:${t.token}`)).toEqual(["base:USDC", "polygon:USDC", "polygon:USDT"]);
  });
});

describe("amounts", () => {
  it("converts USD to base units exactly", () => {
    expect(usdToUnits("1200.00", 6)).toBe(1_200_000_000n);
    expect(usdToUnits("0.1", 6)).toBe(100_000n);
    expect(usdToUnits("19.99", 18)).toBe(19_990_000_000_000_000_000n);
    expect(formatUnits(1_200_003_471n, 6)).toBe("1200.003471");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(maxSuffix(6)).toBe(9_999n);
  });
});

describe("extractEvmTransfers", () => {
  const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
  const from = "0x00000000000000000000000000000000000000aa";
  const to = "0x00000000000000000000000000000000000000bb";

  it("decodes ERC-20 Transfer logs and skips others", () => {
    const logs = [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", logIndex: 7, topics: [TRANSFER, pad(from), pad(to)], data: encodeAbiParameters([{ type: "uint256" }], [1_200_000_001n]) },
      { address: "0x1111111111111111111111111111111111111111", logIndex: 8, topics: [pad("0x01")], data: "0x" },
    ] as never;
    const out = extractEvmTransfers("base", "0xabc", logs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ logIndex: 7, amountUnits: 1_200_000_001n });
    expect(out[0]!.to.toLowerCase()).toBe(to);
  });
});

describe("extractSolanaTransfers", () => {
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const bal = (accountIndex: number, owner: string, amount: string) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: "" } });

  it("derives the recipient's received amount from token-account deltas", () => {
    const tx = { meta: { preTokenBalances: [bal(1, "Payer", "5000000000"), bal(2, "Merchant", "10")], postTokenBalances: [bal(1, "Payer", "3799999999"), bal(2, "Merchant", "1200000011")] } };
    expect(extractSolanaTransfers("sig", tx as never)).toEqual([
      { chain: "solana", txHash: "sig", logIndex: null, tokenAddress: MINT, from: "Payer", to: "Merchant", amountUnits: 1_200_000_001n },
    ]);
  });

  it("handles a newly created recipient token account (no pre balance)", () => {
    const tx = { meta: { preTokenBalances: [bal(1, "Payer", "2000000")], postTokenBalances: [bal(1, "Payer", "0"), bal(2, "Merchant", "2000000")] } };
    expect(extractSolanaTransfers("sig", tx as never)[0]).toMatchObject({ to: "Merchant", amountUnits: 2_000_000n });
  });
});
