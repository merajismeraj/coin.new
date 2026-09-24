"use client";

import { CHAINS, chainFamily, walletFamily, type Merchant } from "@coinnew/shared-types";
import { useFormState } from "react-dom";
import { CopyButton } from "@/components/copy-button";
import { SubmitButton } from "@/components/submit-button";
import { ErrorBanner, Field, Input } from "@/components/ui";
import { issueApiKey, updateMerchant, type IssueKeyState } from "../actions";

export function ProfileForm({ merchant, idem }: { merchant: Merchant; idem: string }) {
  const [state, action] = useFormState(updateMerchant, {});
  const f = state.fields ?? {};
  const family = walletFamily(merchant.default_receiving_wallet);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idem" value={state.idem ?? idem} />
      <ErrorBanner message={state.error} />
      {state.saved && <p className="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>}
      <Field label="Receiving wallet" hint="Funds settle here directly. Changing to a different chain family resets enabled chains." error={f.default_receiving_wallet}>
        <Input name="default_receiving_wallet" defaultValue={merchant.default_receiving_wallet} className="font-mono" required />
      </Field>
      <Field label="Enabled chains" error={f.preferred_chains}>
        <div className="flex flex-wrap gap-2">
          {CHAINS.filter((c) => chainFamily(c) === family).map((c) => (
            <label key={c} className="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm capitalize dark:border-zinc-700">
              <input type="checkbox" name="preferred_chains" value={c} defaultChecked={merchant.preferred_chains.includes(c)} className="accent-brand" />
              {c}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Webhook URL" hint="HTTPS endpoint for invoice events (delivered from Phase 2)" error={f.webhook_url}>
        <Input name="webhook_url" type="url" defaultValue={merchant.webhook_url ?? ""} placeholder="https://example.com/webhooks/coinnew" />
      </Field>
      <Field label="Payout preference" hint="Fiat payout via a licensed partner rail arrives in Phase 3.">
        <Input value={merchant.payout_preference === "crypto" ? "Stablecoin to my wallet" : "Fiat via partner"} disabled />
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
