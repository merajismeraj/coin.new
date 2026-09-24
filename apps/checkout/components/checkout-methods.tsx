"use client";

import type { CheckoutInvoice } from "@coinnew/shared-types";
import { useState } from "react";
import { BankTransferPanel, CardPanel } from "./fiat-panels";
import { PayPanel } from "./pay-panel";
import { Providers } from "./providers";

type Method = "wallet" | "bank_transfer" | "card";
const LABEL: Record<Method, string> = { wallet: "Crypto wallet", bank_transfer: "Bank transfer", card: "Card" };

export function CheckoutMethods({ invoice }: { invoice: CheckoutInvoice }) {
  const methods: Method[] = [...(invoice.payment_options.length ? ["wallet" as const] : []), ...invoice.fiat_methods];
  const [method, setMethod] = useState<Method>(methods[0]!);
  return (
    <div className="space-y-4">
      {methods.length > 1 && (
        <div role="tablist" className="grid gap-1 rounded-lg bg-zinc-100 p-1 text-sm dark:bg-zinc-800" style={{ gridTemplateColumns: `repeat(${methods.length}, 1fr)` }}>
          {methods.map((m) => (
            <button key={m} role="tab" aria-selected={method === m} onClick={() => setMethod(m)}
              className="rounded-md px-2 py-1.5 font-medium text-zinc-600 aria-selected:bg-white aria-selected:text-zinc-900 aria-selected:shadow-sm dark:text-zinc-300 dark:aria-selected:bg-zinc-900 dark:aria-selected:text-white">
              {LABEL[m]}
            </button>
          ))}
        </div>
      )}
      {method === "wallet" && (
        <Providers>
          <PayPanel invoice={invoice} />
        </Providers>
      )}
      {method === "bank_transfer" && <BankTransferPanel invoice={invoice} />}
      {method === "card" && <CardPanel invoice={invoice} />}
    </div>
  );
}
