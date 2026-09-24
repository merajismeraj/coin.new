import { randomUUID } from "node:crypto";
import type { Merchant } from "@coinnew/shared-types";
import { authedApi } from "@/lib/api";
import { NewInvoiceForm } from "./form";

export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const me = await authedApi<Merchant>("/v1/merchants/me");
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
      <NewInvoiceForm idem={randomUUID()} chains={me.preferred_chains} />
    </div>
  );
}
