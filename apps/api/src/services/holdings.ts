import { chainInfo, formatUnits, TOKENS_BY_NETWORK, type Network } from "@coinnew/chains";
import type { ChainVerifier } from "@coinnew/chains/verify";
import { chainFamily, type Chain, type WalletHolding, type WalletHoldings } from "@coinnew/shared-types";

const TTL_MS = 30_000;
const READ_TIMEOUT_MS = 8_000;

export interface HoldingsOwner {
  id: string;
  evmWallet: string | null;
  solanaWallet: string | null;
  preferredChains: Chain[];
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms).unref())]);

/**
 * Amounts of the registry's stablecoins in the merchant's own wallets, read
 * straight from chain. Only registry contracts are queried: wallets collect
 * spoofed "USDC"/"POL" airdrops, and a symbol proves nothing.
 *
 * Results are cached per merchant+wallets for 30s so dashboard reloads don't
 * burn RPC quota. One failing chain never fails the whole response.
 */
export class HoldingsService {
  private cache = new Map<string, { at: number; value: Promise<WalletHoldings> }>();

  constructor(
    private verifier: ChainVerifier,
    private network: Network,
    private now: () => number = Date.now,
  ) {}

  get(m: HoldingsOwner): Promise<WalletHoldings> {
    const key = [m.id, m.evmWallet, m.solanaWallet, [...m.preferredChains].sort().join(",")].join("|");
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = this.read(m);
    this.cache.set(key, { at: this.now(), value });
    for (const [k, v] of this.cache) if (this.now() - v.at >= TTL_MS) this.cache.delete(k);
    return value;
  }

  private async read(m: HoldingsOwner): Promise<WalletHoldings> {
    const rows = TOKENS_BY_NETWORK[this.network].flatMap((t) => {
      const wallet = chainFamily(t.chain) === "evm" ? m.evmWallet : m.solanaWallet;
      return wallet ? [{ t, wallet }] : [];
    });
    const data = await Promise.all(
      rows.map(async ({ t, wallet }): Promise<WalletHolding> => {
        const base = { chain: t.chain, token: t.token, wallet, token_address: t.address, accepting: m.preferredChains.includes(t.chain) };
        try {
          const units = await withTimeout(this.verifier.balance(t.chain, { tokenAddress: t.address, owner: wallet }), READ_TIMEOUT_MS);
          return { ...base, balance: formatUnits(units, t.decimals), error: null };
        } catch {
          return { ...base, balance: null, error: `Couldn't read ${chainInfo(this.network, t.chain).name} right now` };
        }
      }),
    );
    // Sum exactly in 18-decimal fixed point, then truncate once to cents.
    const total = data.reduce((sum, r) => sum + (r.balance ? toFixed18(r.balance) : 0n), 0n);
    const cents = total / 10n ** 16n;
    return {
      network: this.network,
      as_of: new Date(this.now()).toISOString(),
      total_usd: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`,
      complete: data.every((r) => !r.error),
      data,
    };
  }
}

/** Truncated, never rounded up: a total should never overstate what's there. */
function toFixed18(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(frac.slice(0, 18).padEnd(18, "0"));
}
