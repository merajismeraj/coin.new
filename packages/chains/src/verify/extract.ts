import type { Chain } from "@coinnew/shared-types";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { decodeEventLog, type Log } from "viem";
import { erc20Abi } from "../index.js";
import type { ObservedTransfer } from "./index.js";

/** All ERC-20 Transfer events in a receipt's logs. Non-Transfer or malformed logs are skipped. */
export function extractEvmTransfers(chain: Chain, txHash: string, logs: Pick<Log, "address" | "topics" | "data" | "logIndex">[]): ObservedTransfer[] {
  const out: ObservedTransfer[] = [];
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", topics: log.topics as never, data: log.data });
      out.push({ chain, txHash, logIndex: log.logIndex ?? null, tokenAddress: log.address, from: ev.args.from, to: ev.args.to, amountUnits: ev.args.value });
    } catch {
      // not an ERC-20 Transfer
    }
  }
  return out;
}

/**
 * SPL transfers derived from token-account deltas: for each (owner, mint) that
 * gained tokens, one transfer. This counts what the recipient actually received,
 * regardless of instruction shape (transfer, transferChecked, via a program).
 */
export function extractSolanaTransfers(txHash: string, tx: Pick<ParsedTransactionWithMeta, "meta">): ObservedTransfer[] {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const delta = new Map<string, { owner: string; mint: string; units: bigint }>();
  const bump = (owner: string | undefined, mint: string, units: bigint) => {
    if (!owner) return;
    const k = `${owner}|${mint}`;
    const cur = delta.get(k) ?? { owner, mint, units: 0n };
    cur.units += units;
    delta.set(k, cur);
  };
  for (const b of post) bump(b.owner, b.mint, BigInt(b.uiTokenAmount.amount));
  for (const b of pre) bump(b.owner, b.mint, -BigInt(b.uiTokenAmount.amount));

  const all = [...delta.values()];
  return all
    .filter((d) => d.units > 0n)
    .map((d) => ({
      chain: "solana" as const,
      txHash,
      logIndex: null,
      tokenAddress: d.mint,
      from: all.find((s) => s.mint === d.mint && s.units < 0n)?.owner ?? null,
      to: d.owner,
      amountUnits: d.units,
    }));
}
