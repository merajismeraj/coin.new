"use client";

import { CHAINS, chainFamily, type Merchant } from "@coinnew/shared-types";
import { useFormState } from "react-dom";
import { CopyButton } from "@/components/copy-button";
import { SubmitButton } from "@/components/submit-button";
import { ErrorBanner, Field, Input } from "@/components/ui";
import { useState } from "react";
import { addBankAccount, issueApiKey, updateMerchant, type IssueKeyState } from "../actions";

const LABEL = { ethereum: "Ethereum", base: "Base", polygon: "Polygon", solana: "Solana" } as const;

export function ProfileForm({ merchant, idem }: { merchant: Merchant; idem: string }) {
  const [state, action] = useFormState(updateMerchant, {});
  const f = state.fields ?? {};
  const w = merchant.receiving_wallets;
  const available = CHAINS.filter((c) => (chainFamily(c) === "evm" ? w.evm : w.solana));
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idem" value={state.idem ?? idem} />
      <ErrorBanner message={state.error} />
      {state.saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="EVM wallet" hint="Ethereum, Base and Polygon" error={f.receiving_wallets}>
          <Input name="evm_wallet" defaultValue={w.evm ?? ""} className="font-mono" placeholder="0x…" autoComplete="off" />
        </Field>
        <Field label="Solana wallet">
          <Input name="solana_wallet" defaultValue={w.solana ?? ""} className="font-mono" placeholder="Base58 address" autoComplete="off" />
        </Field>
      </div>
      <p className="text-xs text-zinc-500">
        Payments settle directly to these addresses. Invoices already opened by a buyer keep the address they were shown.
      </p>
      <Field label="Enabled chains" error={f.preferred_chains}>
        <div className="flex flex-wrap gap-2">
          {available.map((c) => (
            <label key={c} className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">
              <input type="checkbox" name="preferred_chains" value={c} defaultChecked={merchant.preferred_chains.includes(c)} className="accent-brand" />
              {LABEL[c]}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Webhook URL" hint="HTTPS endpoint for invoice.paid, invoice.canceled and settlement.confirmed" error={f.webhook_url}>
        <Input name="webhook_url" type="url" defaultValue={merchant.webhook_url ?? ""} placeholder="https://example.com/webhooks/coinnew" />
      </Field>
      <SubmitButton pendingText="Saving…">Save</SubmitButton>
    </form>
  );
}

export function IssueKeyForm() {
  const [state, action] = useFormState<IssueKeyState, FormData>(issueApiKey, {});
  return (
    <div className="space-y-3">
      {state.issuedKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="mb-2 font-medium">Copy this key now — it won’t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1.5 font-mono text-xs dark:bg-zinc-900">{state.issuedKey}</code>
            <CopyButton value={state.issuedKey} />
          </div>
        </div>
      )}
      <ErrorBanner message={state.error} />
      <form key={state.issuedKey} action={action} className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="New key label">
            <Input name="label" placeholder="e.g. production server" maxLength={100} />
          </Field>
        </div>
        <SubmitButton variant="secondary" pendingText="Issuing…">Issue key</SubmitButton>
      </form>
    </div>
  );
}

export function BankAccountForm({ idem }: { idem: string }) {
  const [state, action] = useFormState(addBankAccount, {});
  const [type, setType] = useState<"us" | "iban">("us");
  const f = state.fields ?? {};
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idem" value={state.idem ?? idem} />
      <input type="hidden" name="account_type" value={type} />
      <ErrorBanner message={state.error} />
      <div className="flex gap-2 text-sm">
        {(["us", "iban"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setType(t)} aria-pressed={type === t}
            className="rounded-md border border-zinc-300 px-3 py-1.5 aria-pressed:border-brand aria-pressed:bg-blue-50 dark:border-zinc-700 dark:aria-pressed:bg-blue-950">
            {t === "us" ? "US account (USD)" : "IBAN (EUR)"}
          </button>
        ))}
      </div>
      <Field label="Account holder" error={f.account_owner_name}><Input name="account_owner_name" required /></Field>
      {type === "us" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank name" error={f.bank_name}><Input name="bank_name" required /></Field>
            <Field label="Payout rail"><select name="rail" className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"><option value="ach">ACH</option><option value="wire">Wire</option></select></Field>
            <Field label="Routing number" error={f.routing_number}><Input name="routing_number" inputMode="numeric" required autoComplete="off" /></Field>
            <Field label="Account number" error={f.account_number}><Input name="account_number" inputMode="numeric" required autoComplete="off" /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Street" error={f.address}><Input name="street" required /></Field>
            <Field label="City"><Input name="city" required /></Field>
            <Field label="State"><Input name="state" /></Field>
            <Field label="Postal code"><Input name="postal_code" required /></Field>
            <Field label="Country" hint="ISO alpha-3, e.g. USA"><Input name="country" defaultValue="USA" maxLength={3} required /></Field>
          </div>
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="IBAN" error={f.iban}><Input name="iban" required autoComplete="off" className="font-mono" /></Field>
          <Field label="BIC / SWIFT" error={f.bic}><Input name="bic" required className="font-mono" /></Field>
          <Field label="Country" hint="ISO alpha-3, e.g. DEU" error={f.country}><Input name="country" maxLength={3} required /></Field>
        </div>
      )}
      <p className="text-xs text-zinc-500">Bank details go straight to our licensed partner. coin.new keeps only the last 4 digits.</p>
      <SubmitButton pendingText="Saving…">Save bank account</SubmitButton>
    </form>
  );
}
