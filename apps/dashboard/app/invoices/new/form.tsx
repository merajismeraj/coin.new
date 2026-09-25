"use client";

import { CHAIN_LABELS, TOKENS, type Chain } from "@coinnew/shared-types";
import { useFormState } from "react-dom";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, Field, Input, Select } from "@/components/ui";
import { createInvoice } from "../../actions";

function Checkboxes({ name, options, labels }: { name: string; options: readonly string[]; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label key={o} className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-blue-50 dark:border-zinc-700 dark:has-[:checked]:bg-blue-950">
          <input type="checkbox" name={name} value={o} defaultChecked className="accent-brand" />
          {labels?.[o] ?? o}
        </label>
      ))}
    </div>
  );
}

export function NewInvoiceForm({ idem, chains }: { idem: string; chains: Chain[] }) {
  const [state, action] = useFormState(createInvoice, {});
  const f = state.fields ?? {};
  // USDG exists only on Robinhood Chain; don't offer it to merchants who haven't enabled that chain.
  const tokens = TOKENS.filter((t) => t !== "USDG" || chains.includes("robinhood"));
  return (
    <Card>
      <form action={action} className="space-y-5">
        <input type="hidden" name="idem" value={state.idem ?? idem} />
        <ErrorBanner message={state.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (USD)" error={f.amount_usd}>
            <Input name="amount_usd" inputMode="decimal" required placeholder="1200.00" pattern="\d+(\.\d{1,2})?" />
          </Field>
          <Field label="Invoice number" hint="Leave blank to auto-number" error={f.invoice_number}>
            <Input name="invoice_number" placeholder="INV-00001" />
          </Field>
        </div>
        <Field label="Buyer email" hint="Optional" error={f.buyer_email}>
          <Input name="buyer_email" type="email" placeholder="ap@client.com" />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="notify_buyer" defaultChecked className="accent-brand" />
          Email the invoice to the buyer (with a reminder before it expires)
        </label>
        <Field label="Accepted tokens" hint="Each token is offered only where it’s listed (e.g. no USDT on Base; USDG only on Robinhood Chain)" error={f.accepted_tokens}>
          <Checkboxes name="accepted_tokens" options={tokens} />
        </Field>
        <Field label="Accepted chains" hint="Chains you’ve enabled in Settings" error={f.accepted_chains}>
          <Checkboxes name="accepted_chains" options={chains} labels={CHAIN_LABELS} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Expires in" error={f.expires_in_hours}>
            <Select name="expires_in_hours" defaultValue="72">
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
              <option value="168">7 days</option>
              <option value="720">30 days</option>
              <option value="">Never</option>
            </Select>
          </Field>
          <Field label="PO number" hint="Optional, stored as metadata">
            <Input name="po_number" placeholder="PO-1029" />
          </Field>
        </div>
        <SubmitButton pendingText="Creating…">Create invoice</SubmitButton>
      </form>
    </Card>
  );
}
