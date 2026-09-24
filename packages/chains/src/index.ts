import type { Chain, Token } from "@coinnew/shared-types";

export type Network = "mainnet" | "testnet";

export interface ChainInfo {
  chain: Chain;
  family: "evm" | "solana";
  name: string;
  /** EVM chain id; null for Solana. */
  chainId: number | null;
  explorerTx: (hash: string) => string;
  /** Block confirmations required before a transfer counts as settled. Solana uses 'finalized' commitment instead. */
  confirmations: number;
  defaultRpc: string;
}

export interface TokenInfo {
  chain: Chain;
  token: Token;
  /** ERC-20 contract address or SPL mint. */
  address: string;
  decimals: number;
}

// Confirmation depth is chain-specific: Polygon PoS has a history of deep
// reorgs, so it waits longer than Ethereum/Base. Override via config if needed.
const CHAINS: Record<Network, Record<Chain, ChainInfo>> = {
  mainnet: {
    ethereum: { chain: "ethereum", family: "evm", name: "Ethereum", chainId: 1, confirmations: 3, defaultRpc: "https://ethereum-rpc.publicnode.com", explorerTx: (h) => `https://etherscan.io/tx/${h}` },
    base: { chain: "base", family: "evm", name: "Base", chainId: 8453, confirmations: 3, defaultRpc: "https://mainnet.base.org", explorerTx: (h) => `https://basescan.org/tx/${h}` },
    polygon: { chain: "polygon", family: "evm", name: "Polygon", chainId: 137, confirmations: 16, defaultRpc: "https://polygon-rpc.com", explorerTx: (h) => `https://polygonscan.com/tx/${h}` },
    solana: { chain: "solana", family: "solana", name: "Solana", chainId: null, confirmations: 1, defaultRpc: "https://api.mainnet-beta.solana.com", explorerTx: (h) => `https://solscan.io/tx/${h}` },
  },
  testnet: {
    ethereum: { chain: "ethereum", family: "evm", name: "Sepolia", chainId: 11155111, confirmations: 2, defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com", explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}` },
    base: { chain: "base", family: "evm", name: "Base Sepolia", chainId: 84532, confirmations: 2, defaultRpc: "https://sepolia.base.org", explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}` },
    polygon: { chain: "polygon", family: "evm", name: "Polygon Amoy", chainId: 80002, confirmations: 2, defaultRpc: "https://rpc-amoy.polygon.technology", explorerTx: (h) => `https://amoy.polygonscan.com/tx/${h}` },
    solana: { chain: "solana", family: "solana", name: "Solana Devnet", chainId: null, confirmations: 1, defaultRpc: "https://api.devnet.solana.com", explorerTx: (h) => `https://solscan.io/tx/${h}?cluster=devnet` },
  },
};

// Only official issuances. USDT is deliberately absent on Base: Tether does not
// issue natively there, and accepting a bridged look-alike is a loss risk.
const TOKENS: Record<Network, TokenInfo[]> = {
  mainnet: [
    { chain: "ethereum", token: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    { chain: "ethereum", token: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    { chain: "base", token: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    { chain: "polygon", token: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    { chain: "polygon", token: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    { chain: "solana", token: "USDC", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    { chain: "solana", token: "USDT", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
  ],
  // Circle's testnet USDC. No official USDT on testnets.
  testnet: [
    { chain: "ethereum", token: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6 },
    { chain: "base", token: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    { chain: "polygon", token: "USDC", address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", decimals: 6 },
    { chain: "solana", token: "USDC", address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
  ],
};

export const chainInfo = (network: Network, chain: Chain): ChainInfo => CHAINS[network][chain];

export const tokenInfo = (network: Network, chain: Chain, token: Token): TokenInfo | undefined =>
  TOKENS[network].find((t) => t.chain === chain && t.token === token);

export const tokensOn = (network: Network, chain: Chain): TokenInfo[] => TOKENS[network].filter((t) => t.chain === chain);

/** Supported (chain, token) pairs from the given sets. */
export function supportedPairs(network: Network, chains: readonly Chain[], tokens: readonly Token[]): TokenInfo[] {
  return TOKENS[network].filter((t) => chains.includes(t.chain) && tokens.includes(t.token));
}

export const sameAddress = (family: "evm" | "solana", a: string, b: string) => (family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Minimal ERC-20 ABI. `transfer` declares no outputs because USDT on Ethereum returns nothing. */
export const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Transfer", inputs: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
] as const;

// ---- Amounts ---------------------------------------------------------------

/** "1200.50" USD → base units at `decimals`, stablecoins at par. */
export function usdToUnits(amountUsd: string, decimals: number): bigint {
  const [whole, frac = ""] = amountUsd.split(".");
  if (decimals < 2) throw new Error("token decimals too small for cent precision");
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(2, "0")) * 10n ** BigInt(decimals - 2);
}

export function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * ERC-20 and SPL transfers carry no memo, so each payment intent gets a unique
 * sub-cent amount: base + suffix, where suffix is in [1, maxSuffix] units below
 * one cent. With 6 decimals that is up to 9,999 concurrent intents per
 * (chain, token, receiving address), and at most $0.009999 over the invoice.
 */
export const maxSuffix = (decimals: number) => 10n ** BigInt(decimals - 2) - 1n;
