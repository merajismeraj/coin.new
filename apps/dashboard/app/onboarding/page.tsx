import { randomUUID } from "node:crypto";
import { OnboardingForm } from "./form";

export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get paid in stablecoins</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Buyers pay straight into <strong>your</strong> wallet. coin.new never holds your funds or your keys.
        </p>
      </div>
      <OnboardingForm idem={randomUUID()} />
    </div>
  );
}
