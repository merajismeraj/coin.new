"use client";

import Link from "next/link";
import { useFormState } from "react-dom";
import { CopyButton } from "@/components/copy-button";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, Field, Input, Select } from "@/components/ui";
import { onboard, type OnboardState } from "../actions";

export function OnboardingForm({ idem, countries }: { idem: string; countries: { code: string; name: string }[] }) {
  const [state, action] = useFormState<OnboardState, FormData>(onboard, {});

  if (state.issuedKey) {
    return (
      <Card title="You’re in. Save your sign-in key">
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          You’ll use this key to sign in on other devices, and developers use it to call the API. We show it only once, so save it in your password manager now.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-zinc-100 px-3 py-2 font-mono text-xs dark:bg-zinc-800">{state.issuedKey}</code>
          <CopyButton value={state.issuedKey} />
        </div>
        <p className="mt-3 text-xs text-zinc-500">You’re already signed in on this device.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/invoices/new" className="inline-flex rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg hover:bg-blue-800">
            I’ve saved it. Create my first invoice
          </Link>
          <Link href="/" className="inline-flex items-center px-2 text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            Go to dashboard
          </Link>
        </div>
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
        <Field label="Work email" hint="Payment notifications go here." error={f.email}>
          <Input name="email" type="email" required autoComplete="email" />
        </Field>
        <Field label="Country where your business is registered" error={f.country_code}>
          <Select name="country_code" required defaultValue="">
            <option value="" disabled>Select a country</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <fieldset className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <legend className="px-1 text-sm font-medium">Where should we send your money?</legend>
          <p className="text-xs text-zinc-500">
            Paste a wallet address you control. Clients pay straight into it. Add at least one; you can change them later in Settings.
          </p>
          <Field label="Ethereum · Base · Polygon address" hint="Starts with 0x. One address works on all three networks." error={f.receiving_wallets}>
            <Input name="evm_wallet" className="font-mono" placeholder="0x…" autoComplete="off" />
          </Field>
          <Field label="Solana address" hint="Optional. Lets clients pay on Solana.">
            <Input name="solana_wallet" className="font-mono" placeholder="Base58 address" autoComplete="off" />
          </Field>
        </fieldset>
        <SubmitButton pendingText="Creating your account…">Create account</SubmitButton>
        <p className="text-xs text-zinc-500">
          Already have an account? <Link href="/login" className="text-brand hover:underline">Sign in</Link>
        </p>
      </form>
    </Card>
  );
}
