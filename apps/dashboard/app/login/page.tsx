"use client";

import Link from "next/link";
import { useFormState } from "react-dom";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, Field, Input } from "@/components/ui";
import { login } from "../actions";

export default function LoginPage({ searchParams }: { searchParams: { expired?: string } }) {
  const [state, action] = useFormState(login, {});
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <Card>
        <form action={action} className="space-y-4">
          <ErrorBanner message={state.error ?? (searchParams.expired ? "Your session key was revoked or expired. Sign in again." : undefined)} />
          <Field label="API key" hint="Paste a key issued at onboarding or from Settings.">
            <Input name="api_key" type="password" autoComplete="off" required placeholder="cn_…" className="font-mono" />
          </Field>
          <SubmitButton pendingText="Checking…">Sign in</SubmitButton>
        </form>
      </Card>
      <p className="text-sm text-zinc-500">
        New to coin.new? <Link href="/onboarding" className="text-brand hover:underline">Create a merchant account</Link>
      </p>
    </div>
  );
}
