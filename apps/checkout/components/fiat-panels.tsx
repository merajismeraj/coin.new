"use client";

import type { BankInstructions, CheckoutInvoice, FiatSession } from "@coinnew/shared-types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

async function startSession(invoiceId: string, body: object): Promise<FiatSession> {
  const res = await fetch(`/api/checkout/${invoiceId}/fiat-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? "Could not start payment");
  return json;
}

function Row({ label, value, mono = true }: { label: string; value: string | null; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="text-zinc-500">{label}</span>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className={`text-right ${mono ? "font-mono" : ""} break-all hover:text-brand`}
        title="Copy"
      >
        {copied ? "Copied" : value}
      </button>
    </div>
  );
}

function Instructions({ i }: { i: BankInstructions }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Include the reference <strong className="font-mono">{i.reference}</strong> exactly, and send exactly {i.amount} {i.currency.toUpperCase()}. Without it the payment can’t be matched.
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        <Row label="Amount" value={`${i.amount} ${i.currency.toUpperCase()}`} />
        <Row label="Reference" value={i.reference} />
        <Row label="Beneficiary" value={i.beneficiary_name} mono={false} />
        <Row label="Bank" value={i.bank_name} mono={false} />
        <Row label="Routing (ABA)" value={i.routing_number} />
        <Row label="Account" value={i.account_number} />
        <Row label="IBAN" value={i.iban} />
        <Row label="BIC" value={i.bic} />
        <Row label="Bank address" value={i.bank_address} mono={false} />
      </div>
      <p className="text-xs text-zinc-500">Tap a value to copy. Funds are received by our licensed partner, Bridge, and settled to the merchant.</p>
    </div>
  );
}

export function BankTransferPanel({ invoice }: { invoice: CheckoutInvoice }) {
  const [rail, setRail] = useState<"ach" | "wire">("ach");
  const [session, setSession] = useState<FiatSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  // Bank payments take hours to days; refresh when the server sees movement.
  useEffect(() => {
    if (!session) return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/checkout/${invoice.id}`, { cache: "no-store" });
      if (res.ok && (await res.json()).status !== "pending") router.refresh();
    }, 15000);
    return () => clearInterval(t);
  }, [session, invoice.id, router]);

  if (session?.instructions) return <Instructions i={session.instructions} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        {(["ach", "wire"] as const).map((r) => (
          <button key={r} onClick={() => setRail(r)} aria-pressed={rail === r}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium aria-pressed:border-brand aria-pressed:bg-blue-50 dark:border-zinc-700 dark:aria-pressed:bg-blue-950">
            {r === "ach" ? "ACH (US)" : "Wire (domestic & international)"}
          </button>
        ))}
      </div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setSession(await startSession(invoice.id, { method: "bank_transfer", rail }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-brand-fg hover:bg-blue-800 disabled:opacity-50"
      >
        {busy ? "Preparing…" : "Get bank details"}
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function CardPanel({ invoice }: { invoice: CheckoutInvoice }) {
  const options = invoice.payment_options;
  const [idx, setIdx] = useState(Math.max(0, options.findIndex((o) => o.chain === "base" && o.token === "USDC")));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const o = options[idx];
  if (!o) return null;
  return (
    <div className="space-y-4">
      <label className="block space-y-1.5 text-sm">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Deliver as</span>
        <select value={idx} onChange={(e) => setIdx(Number(e.target.value))} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900">
          {options.map((x, i) => <option key={`${x.chain}:${x.token}`} value={i}>{x.token} on {x.chain_name}</option>)}
        </select>
      </label>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const s = await startSession(invoice.id, { method: "card", chain: o.chain, token: o.token });
            window.location.href = s.redirect_url!;
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
        className="w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-brand-fg hover:bg-blue-800 disabled:opacity-50"
      >
        {busy ? "Opening MoonPay…" : "Continue to card payment"}
      </button>
      <p className="text-xs text-zinc-500">Card payments are processed by MoonPay, which may ask you to verify your identity. Card fees are shown before you pay.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
