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
        <Field label="Amount" error={f.amount_usd}>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg text-zinc-400">$</span>
            <Input name="amount_usd" inputMode="decimal" required autoFocus placeholder="1,200.00" pattern="[\d,]+(\.\d{1,2})?" title="A dollar amount, e.g. 1200 or 1,200.50" className="!py-3 !pl-7 !text-lg font-semibold tabular-nums" />
          </div>
        </Field>
        <Field label="Client email" hint="We’ll email them the payment link. Leave blank to share the link yourself." error={f.buyer_email}>
          <Input name="buyer_email" type="email" placeholder="accounts@client.com" />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="notify_buyer" defaultChecked className="mt-0.5 accent-brand" />
          <span>Email the invoice, plus a reminder before it expires</span>
        </label>

        <details className="group rounded-md border border-zinc-200 dark:border-zinc-800" open={Boolean(f.accepted_tokens || f.accepted_chains || f.expires_in_hours || f.invoice_number)}>
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm">
            <span>
              <span className="font-medium">Payment options</span>
              <span className="ml-2 text-zinc-500">All your networks · expires in 3 days</span>
            </span>
            <span className="text-zinc-400 transition group-open:rotate-90">›</span>
          </summary>
          <div className="space-y-5 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
            <Field label="Accepted stablecoins" hint="Each is offered only where it’s officially issued (e.g. no USDT on Base)" error={f.accepted_tokens}>
              <Checkboxes name="accepted_tokens" options={tokens} />
            </Field>
            <Field label="Accepted networks" hint="Networks you’ve enabled in Settings" error={f.accepted_chains}>
              <Checkboxes name="accepted_chains" options={chains} labels={CHAIN_LABELS} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Link expires in" error={f.expires_in_hours}>
                <Select name="expires_in_hours" defaultValue="72">
                  <option value="24">24 hours</option>
                  <option value="72">3 days</option>
                  <option value="168">7 days</option>
                  <option value="720">30 days</option>
                  <option value="">Never</option>
                </Select>
              </Field>
              <Field label="Invoice number" hint="Leave blank to auto-number" error={f.invoice_number}>
                <Input name="invoice_number" placeholder="INV-00001" />
              </Field>
            </div>
            <Field label="PO number" hint="Optional, for your records">
              <Input name="po_number" placeholder="PO-1029" />
            </Field>
          </div>
        </details>

        <SubmitButton pendingText="Creating…">Create invoice and get link</SubmitButton>
      </form>
    </Card>
  );
}
