import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { countries } from "@/lib/countries";
import { OnboardingForm } from "./form";

export const metadata: Metadata = { title: "Get started" };

export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Start getting paid in stablecoins</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Takes about two minutes. Your clients pay straight into <strong>your</strong> wallet; coin.new never holds your funds or your keys.
        </p>
      </div>
      <OnboardingForm idem={randomUUID()} countries={countries()} />
    </div>
  );
}
