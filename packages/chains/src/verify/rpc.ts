import type { Chain } from "@coinnew/shared-types";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, http, type PublicClient } from "viem";
import { chainInfo, erc20Abi, type Network } from "../index.js";
import { extractEvmTransfers, extractSolanaTransfers } from "./extract.js";
import type { ChainVerifier, VerifiedTx } from "./index.js";

export interface RpcConfig {
  network: Network;
  rpcUrls?: Partial<Record<Chain, string>>;
  confirmations?: Partial<Record<Chain, number>>;
}

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxzAWVp7rnQnKgDDTxtcwNwgRr6rDTuH");
const MAX_SCAN_BLOCKS = 5_000n;
const NOT_FOUND: VerifiedTx = { found: false, final: false, blockTime: null, transfers: [] };

export const associatedTokenAddress = (owner: string, mint: string) =>
  PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0];

/** Read-only chain access over JSON-RPC. Holds no keys and never signs. */
export class RpcChainVerifier implements ChainVerifier {
  private evm = new Map<Chain, PublicClient>();
  private sol?: Connection;

  constructor(private cfg: RpcConfig) {}

  private url(chain: Chain) {
    return this.cfg.rpcUrls?.[chain] ?? chainInfo(this.cfg.network, chain).defaultRpc;
  }

  private evmClient(chain: Chain): PublicClient {
    let c = this.evm.get(chain);
    // cacheTime 0: finality depends on the current head; viem otherwise caches getBlockNumber (~4s).
    if (!c) this.evm.set(chain, (c = createPublicClient({ transport: http(this.url(chain), { retryCount: 2 }), cacheTime: 0 }) as PublicClient));
    return c;
  }

  private solana(): Connection {
    return (this.sol ??= new Connection(this.url("solana"), "confirmed"));
  }

  async head(chain: Chain): Promise<bigint> {
    if (chain === "solana") return BigInt(await this.solana().getSlot("finalized"));
    return this.evmClient(chain).getBlockNumber();
  }

  async verify(chain: Chain, txHash: string): Promise<VerifiedTx> {
    return chain === "solana" ? this.verifySolana(txHash) : this.verifyEvm(chain, txHash);
  }

  private async verifyEvm(chain: Chain, txHash: string): Promise<VerifiedTx> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return NOT_FOUND;
    const client = this.evmClient(chain);
    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch((e: Error) => {
      if (e.name === "TransactionReceiptNotFoundError") return null;
      throw e;
    });
    if (!receipt || receipt.status !== "success") return NOT_FOUND;
    const [headBlock, block] = await Promise.all([client.getBlockNumber(), client.getBlock({ blockNumber: receipt.blockNumber })]);
    const required = BigInt(this.cfg.confirmations?.[chain] ?? chainInfo(this.cfg.network, chain).confirmations);
    return {
      found: true,
      final: headBlock - receipt.blockNumber + 1n >= required,
      blockTime: new Date(Number(block.timestamp) * 1000),
      transfers: extractEvmTransfers(chain, receipt.transactionHash, receipt.logs),
    };
  }

  private async verifySolana(sig: string): Promise<VerifiedTx> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return NOT_FOUND;
    const conn = this.solana();
    const [tx, status] = await Promise.all([
      conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }),
      conn.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    if (!tx || tx.meta?.err) return NOT_FOUND;
    return {
      found: true,
      final: status.value?.confirmationStatus === "finalized",
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
      transfers: extractSolanaTransfers(sig, tx),
    };
  }

  async scan(chain: Chain, { tokenAddress, to, fromBlock }: { tokenAddress: string; to: string; fromBlock: bigint | null }): Promise<string[]> {
    if (chain === "solana") {
      const sigs = await this.solana().getSignaturesForAddress(associatedTokenAddress(to, tokenAddress), { limit: 25 });
      return sigs.filter((s) => !s.err).map((s) => s.signature);
    }
    const client = this.evmClient(chain);
    const head = await client.getBlockNumber();
    const floor = head > MAX_SCAN_BLOCKS ? head - MAX_SCAN_BLOCKS : 0n;
    const logs = await client.getLogs({
      address: tokenAddress as `0x${string}`,
      event: erc20Abi[2],
      args: { to: to as `0x${string}` },
      fromBlock: fromBlock && fromBlock > floor ? fromBlock : floor,
      toBlock: head,
    });
    return [...new Set(logs.map((l) => l.transactionHash).filter((h): h is `0x${string}` => !!h))];
  }
}
