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
        <Field label="Country" hint="ISO code, e.g. AE, US, GB" error={f.country_code}>
          <Input name="country_code" required maxLength={2} className="uppercase" placeholder="AE" />
        </Field>
        <Field label="Receiving wallet" hint="An address you control (EVM 0x… or Solana). Payments settle here directly." error={f.default_receiving_wallet}>
          <Input name="default_receiving_wallet" required className="font-mono" placeholder="0x…" />
        </Field>
        <SubmitButton pendingText="Creating…">Create account</SubmitButton>
      </form>
    </Card>
  );
}
