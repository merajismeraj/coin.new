import { CHAIN_LABELS, type WalletHoldings } from "@coinnew/shared-types";
import { Card, date, usd } from "@/components/ui";

const amount = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Stablecoins in the merchant's own wallets. Read-only: coin.new never holds or moves these funds. */
export function WalletBalanceCard({ holdings }: { holdings: WalletHoldings | null }) {
  if (!holdings) {
    return (
      <Card title="Wallet balance">
        <p className="text-sm text-zinc-500">Your wallet balance is unavailable right now. Payments are unaffected.</p>
      </Card>
    );
  }
  const held = holdings.data.filter((r) => r.error || (r.balance && r.balance !== "0"));
  const wallets = [...new Set(holdings.data.map((r) => r.wallet))];

  return (
    <Card
      title="Wallet balance"
      action={
        <div className="text-right">
          <div className="text-xl font-semibold tabular-nums">
            {usd(holdings.total_usd)}
            {!holdings.complete && <span className="text-sm font-normal text-amber-700 dark:text-amber-400">+</span>}
          </div>
          <div className="text-xs text-zinc-500">stablecoins at par{holdings.network === "testnet" && " · testnet"}</div>
        </div>
      }
    >
      {held.length === 0 ? (
        <p className="text-sm text-zinc-500">No stablecoins in your receiving wallets yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {held.map((r) => (
            <li key={`${r.chain}:${r.token}`} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <span className="font-medium">{r.token}</span>
                {r.bridged && <span className="text-zinc-500"> (bridged)</span>} <span className="text-zinc-500">on {CHAIN_LABELS[r.chain]}</span>
                {!r.accepting && (
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">not accepting</span>
                )}
              </div>
              {r.error ? (
                <span className="text-xs text-amber-700 dark:text-amber-400">{r.error}</span>
              ) : (
                <span className="tabular-nums">{amount(r.balance!)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-zinc-500">
        Read live from chain for <span className="font-mono">{wallets.map(short).join(", ")}</span> · as of {date(holdings.as_of)}. Only the
        stablecoin contracts coin.new accepts are counted; look-alike tokens airdropped to your wallet are ignored. These funds are in your wallet: coin.new never
        holds them.
        {!holdings.complete && " Some chains couldn’t be read, so the total may be higher."}
      </p>
    </Card>
  );
}
