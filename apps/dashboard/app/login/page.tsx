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
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <Card>
        <form action={action} className="space-y-4">
          <ErrorBanner message={state.error ?? (searchParams.expired ? "Your session ended. Sign in again with your key." : undefined)} />
          <Field label="Sign-in key" hint="The key you saved when you created your account (starts with cn_). You can issue new keys in Settings.">
            <Input name="api_key" type="password" autoComplete="off" required placeholder="cn_…" className="font-mono" />
          </Field>
          <SubmitButton pendingText="Checking…">Sign in</SubmitButton>
        </form>
      </Card>
      <p className="text-sm text-zinc-500">
        New to coin.new? <Link href="/onboarding" className="text-brand hover:underline">Create an account</Link> and send your first payment link in minutes.
      </p>
    </div>
  );
}
