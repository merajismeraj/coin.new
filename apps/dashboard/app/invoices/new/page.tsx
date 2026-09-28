import { randomUUID } from "node:crypto";
import type { Merchant } from "@coinnew/shared-types";
import { authedApi } from "@/lib/api";
import { NewInvoiceForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const me = await authedApi<Merchant>("/v1/merchants/me");
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
        <p className="mt-1 text-sm text-zinc-500">You’ll get a payment link to share. Your client pays in stablecoins, straight to your wallet.</p>
      </div>
      <NewInvoiceForm idem={randomUUID()} chains={me.preferred_chains} />
    </div>
  );
}
