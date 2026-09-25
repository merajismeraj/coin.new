import type { Chain } from "@coinnew/shared-types";

/** A token transfer as observed on-chain. The only thing the matcher trusts. */
export interface ObservedTransfer {
  chain: Chain;
  txHash: string;
  /** EVM log index; Solana has none (one delta per owner+mint per tx). */
  logIndex: number | null;
  tokenAddress: string;
  from: string | null;
  to: string;
  amountUnits: bigint;
}

export interface VerifiedTx {
  /** Transaction exists and succeeded. */
  found: boolean;
  /** Enough confirmations (EVM) or finalized (Solana) to treat as settled. */
  final: boolean;
  blockTime: Date | null;
  transfers: ObservedTransfer[];
}

/**
 * Reads a transaction straight from the chain. Indexer webhooks only tell us
 * *where to look*; payments are marked paid only on what this returns.
 */
export interface ChainVerifier {
  verify(chain: Chain, txHash: string): Promise<VerifiedTx>;
  /** Candidate tx hashes that sent `tokenAddress` to `to` since `fromBlock` (fallback when webhooks are down). */
  scan(chain: Chain, args: { tokenAddress: string; to: string; fromBlock: bigint | null }): Promise<string[]>;
  /** Current head block (EVM) / slot (Solana), used as an intent's scan start. */
  head(chain: Chain): Promise<bigint>;
  /** Token balance of `owner` in base units (read-only; 0 when a Solana token account doesn't exist yet). */
  balance(chain: Chain, args: { tokenAddress: string; owner: string }): Promise<bigint>;
}

export { RpcChainVerifier, type RpcConfig } from "./rpc.js";
export { extractEvmTransfers, extractSolanaTransfers } from "./extract.js";
