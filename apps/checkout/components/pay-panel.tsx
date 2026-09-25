"use client";

import { erc20Abi } from "@coinnew/chains";
import type { CheckoutInvoice, OnchainIntent, PaymentOption } from "@coinnew/shared-types";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWriteContract } from "wagmi";

type Step = { kind: "choose" } | { kind: "review"; intent: OnchainIntent } | { kind: "sent"; intent: OnchainIntent; tx: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errorText = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "Something went wrong";
  return /reject|denied|cancel/i.test(m) ? "You cancelled the request in your wallet." : m;
};

function Btn(p: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "ghost" }) {
  const { tone = "primary", className = "", ...rest } = p;
  const style =
    tone === "primary"
      ? "bg-brand text-brand-fg hover:bg-blue-800 disabled:opacity-50"
      : "border border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800";
  return <button {...rest} className={`w-full rounded-lg px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed ${style} ${className}`} />;
}

export function PayPanel({ invoice }: { invoice: CheckoutInvoice }) {
  const [option, setOption] = useState<PaymentOption>(invoice.payment_options[0]!);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const isSolana = option.chain === "solana";

  // EVM
  const evm = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  // Solana
  const sol = useWallet();
  const { connection } = useConnection();

  const payer = isSolana ? sol.publicKey?.toBase58() : evm.address;

  // Once a tx is sent, poll until the server sees it, then re-render from server state.
  useEffect(() => {
    if (step.kind !== "sent") return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/checkout/${invoice.id}`, { cache: "no-store" });
      if (res.ok && (await res.json()).status !== "pending") router.refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [step.kind, invoice.id, router]);

  const chains = useMemo(() => [...new Map(invoice.payment_options.map((o) => [o.chain, o.chain_name])).entries()], [invoice.payment_options]);
  const tokensForChain = invoice.payment_options.filter((o) => o.chain === option.chain);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const getIntent = () =>
    run(async () => {
      const res = await fetch(`/api/checkout/${invoice.id}/intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: option.chain, token: option.token, payer_address: payer }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not start payment");
      setStep({ kind: "review", intent: body });
    });

  const pay = (intent: OnchainIntent) =>
    run(async () => {
      let tx: string;
      if (intent.chain === "solana") {
        if (!sol.publicKey) throw new Error("Connect a Solana wallet first");
        const mint = new PublicKey(intent.token_address);
        const merchant = new PublicKey(intent.to_address);
        const from = getAssociatedTokenAddressSync(mint, sol.publicKey);
        const to = getAssociatedTokenAddressSync(mint, merchant);
        const t = new Transaction().add(
          // Creates the merchant's token account if it doesn't exist yet (buyer pays the small rent).
          createAssociatedTokenAccountIdempotentInstruction(sol.publicKey, to, merchant, mint),
          createTransferCheckedInstruction(from, mint, to, sol.publicKey, BigInt(intent.amount_units), intent.decimals),
        );
        tx = await sol.sendTransaction(t, connection);
      } else {
        if (evm.chainId !== intent.chain_id) await switchChainAsync({ chainId: intent.chain_id! });
        tx = await writeContractAsync({
          chainId: intent.chain_id!,
          address: intent.token_address as `0x${string}`,
          abi: erc20Abi,
          functionName: "transfer",
          args: [intent.to_address as `0x${string}`, BigInt(intent.amount_units)],
        });
      }
      setStep({ kind: "sent", intent, tx });
    });

  if (step.kind === "sent") {
    return (
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-brand" aria-hidden />
        <p className="font-semibold">Payment sent</p>
        <p className="text-sm text-zinc-500">Waiting for the network to confirm. You can close this page; {invoice.merchant_name} will be notified.</p>
        <p className="truncate font-mono text-xs text-zinc-400">{step.tx}</p>
      </div>
    );
  }

  if (step.kind === "review") {
    const i = step.intent;
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-800/50">
          <p className="text-xs uppercase tracking-wide text-zinc-500">You send exactly</p>
          <p className="mt-1 font-mono text-xl font-semibold">{i.amount} {i.token}</p>
          <p className="mt-1 text-xs text-zinc-500">
            on {i.chain_name} to {short(i.to_address)}. The last digits identify your payment.
          </p>
        </div>
        <Btn onClick={() => pay(i)} disabled={busy}>{busy ? "Confirm in your wallet…" : `Pay ${i.amount} ${i.token}`}</Btn>
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Paying from an exchange or another wallet?</summary>
          <div className="mt-2 space-y-1">
            <p>Send <strong>exactly</strong> <span className="font-mono">{i.amount} {i.token}</span> on <strong>{i.chain_name}</strong> to:</p>
            <p className="break-all rounded bg-zinc-100 p-2 font-mono dark:bg-zinc-800">{i.to_address}</p>
            {i.bridged && (
              <p>
                Only this {i.token} contract counts: <span className="break-all font-mono">{i.token_address}</span>
              </p>
            )}
            <p>If your exchange deducts a fee from the amount, the payment won’t be matched automatically.</p>
          </div>
        </details>
        <button className="w-full text-xs text-zinc-500 hover:underline" onClick={() => setStep({ kind: "choose" })}>Change network or token</button>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Network</p>
        <div className="grid grid-cols-2 gap-2">
          {chains.map(([chain, name]) => (
            <button
              key={chain}
              onClick={() => setOption(invoice.payment_options.find((o) => o.chain === chain)!)}
              aria-pressed={option.chain === chain}
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium aria-pressed:border-brand aria-pressed:bg-blue-50 dark:border-zinc-700 dark:aria-pressed:bg-blue-950"
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      {tokensForChain.length > 1 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Token</p>
          <div className="flex gap-2">
            {tokensForChain.map((o) => (
              <button
                key={o.token}
                onClick={() => setOption(o)}
                aria-pressed={option.token === o.token}
                className="flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium aria-pressed:border-brand aria-pressed:bg-blue-50 dark:border-zinc-700 dark:aria-pressed:bg-blue-950"
              >
                {o.token}
                {o.bridged && <span className="font-normal text-zinc-500"> (bridged)</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      {option.bridged && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This {option.token} on {option.chain_name} is bridged from Ethereum, not issued by Circle. Make sure your wallet holds this exact token, or
          choose another option.
        </p>
      )}

      {payer ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Connected: <span className="font-mono">{short(payer)}</span></span>
            <button className="hover:underline" onClick={() => (isSolana ? sol.disconnect() : disconnect())}>Disconnect</button>
          </div>
          <Btn onClick={getIntent} disabled={busy}>{busy ? "Preparing…" : `Continue with ${option.token}`}</Btn>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Connect wallet</p>
          {isSolana
            ? sol.wallets.filter((w) => w.readyState === "Installed").map((w) => (
                <Btn key={w.adapter.name} tone="ghost" disabled={busy} onClick={() => run(async () => sol.select(w.adapter.name))}>
                  {w.adapter.name}
                </Btn>
              ))
            : connectors.map((c) => (
                <Btn key={c.uid} tone="ghost" disabled={busy} onClick={() => run(async () => void (await connectAsync({ connector: c, chainId: option.chain_id! })))}>
                  {c.name === "Injected" ? "Browser wallet" : c.name}
                </Btn>
              ))}
          {isSolana && !sol.wallets.some((w) => w.readyState === "Installed") && (
            <p className="text-sm text-zinc-500">No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.</p>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
