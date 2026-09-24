"use client";

import Link from "next/link";
import { useFormState } from "react-dom";
import { CopyButton } from "@/components/copy-button";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, Field, Input } from "@/components/ui";
import { onboard, type OnboardState } from "../actions";

export function OnboardingForm({ idem }: { idem: string }) {
  const [state, action] = useFormState<OnboardState, FormData>(onboard, {});

  if (state.issuedKey) {
    return (
      <Card title="Save your API key">
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          This is the only time it will be shown. Store it in your secrets manager — you’ll need it to sign in and to call the API.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">{state.issuedKey}</code>
          <CopyButton value={state.issuedKey} />
        </div>
        <Link href="/" className="mt-5 inline-flex rounded-md bg-brand px-3.5 py-2 text-sm font-medium text-brand-fg hover:bg-blue-800">
          I’ve saved it — continue
        </Link>
      </Card>
    );
  }

  const f = state.fields ?? {};
  return (
    <Card>
      <form action={action} className="space-y-4">
        <input type="hidden" name="idem" value={state.idem ?? idem} />
        <ErrorBanner message={state.error} />
        <Field label="Business name" error={f.business_name}>
          <Input name="business_name" required maxLength={200} />
        </Field>
        <Field label="Work email" error={f.email}>
          <Input name="email" type="email" required />
        </Field>
        <Field label="Country of incorporation" hint="Two-letter ISO code, e.g. US, GB, SG, AE, BR" error={f.country_code}>
          <Input name="country_code" required maxLength={2} className="uppercase" placeholder="US" />
        </Field>
        <fieldset className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-sm font-medium">Receiving wallets</legend>
          <p className="text-xs text-zinc-500">Addresses you control. Buyers pay straight into them. Add at least one.</p>
          <Field label="Ethereum · Base · Polygon" error={f.receiving_wallets}>
            <Input name="evm_wallet" className="font-mono" placeholder="0x…" autoComplete="off" />
          </Field>
          <Field label="Solana">
            <Input name="solana_wallet" className="font-mono" placeholder="Base58 address" autoComplete="off" />
          </Field>
        </fieldset>
        <SubmitButton pendingText="Creating…">Create account</SubmitButton>
      </form>
    </Card>
  );
}
