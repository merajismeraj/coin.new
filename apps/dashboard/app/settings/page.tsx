import { randomUUID } from "node:crypto";
import type { ApiKeySummary, Merchant, PartnerStatus } from "@coinnew/shared-types";
import { authedApi, sessionKeyId } from "@/lib/api";
import { SubmitButton } from "@/components/submit-button";
import { Card, ErrorBanner, date } from "@/components/ui";
import { RevealSecret } from "@/components/secret";
import { revokeApiKey, rotateWebhookSecret, setPayoutPreference, startPartnerOnboarding } from "../actions";
import { BankAccountForm, IssueKeyForm, ProfileForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: { error?: string } }) {
  const [me, partner, keys, webhook] = await Promise.all([
    authedApi<Merchant>("/v1/merchants/me"),
    authedApi<PartnerStatus>("/v1/merchants/me/partner"),
    authedApi<{ data: ApiKeySummary[] }>("/v1/merchants/me/api-keys"),
    authedApi<{ secret: string }>("/v1/merchants/me/webhook-secret"),
  ]);
  const active = keys.data.filter((k) => !k.revoked_at);
  const currentKeyId = sessionKeyId();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">{me.business_name} · {me.email} · {me.country_code}</p>
      </div>
      <ErrorBanner message={searchParams.error} />

      <Card title="Payouts">
        <ProfileForm merchant={me} idem={randomUUID()} />
      </Card>

      <Card title="Bank payouts & bank-transfer checkout">
        <p className="mb-4 text-sm text-zinc-500">
          Verify your business with our licensed partner (Bridge) to let buyers pay by bank transfer and, optionally, to receive
          payouts in your bank account. Verification and conversion happen at the partner; coin.new never holds funds.
        </p>
        <PartnerSection partner={partner} merchant={me} />
      </Card>

      <Card title="Webhook signing secret">
        <p className="mb-3 text-sm text-zinc-500">
          Every webhook carries <code className="font-mono text-xs">X-coinnew-Signature: t=…,v1=…</code>, an HMAC-SHA256 of{" "}
          <code className="font-mono text-xs">{"<t>.<raw body>"}</code> with this secret. Verify it and reject timestamps older than 5 minutes.
        </p>
        <RevealSecret value={webhook.secret} />
        <form action={rotateWebhookSecret} className="mt-3">
          <SubmitButton variant="secondary" pendingText="Rotating…">Rotate secret</SubmitButton>
        </form>
      </Card>

      <Card title="API keys">
        <ul className="mb-5 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {keys.data.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-4 py-2.5">
              <div>
                <span className="font-medium">{k.label ?? "Untitled"}</span>
                <span className="ml-2 font-mono text-xs text-zinc-500">{k.id.slice(0, 8)}</span>
                {k.id === currentKeyId && (
                  <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">This session</span>
                )}
                <div className="text-xs text-zinc-500">
                  Created {date(k.created_at)}
                  {k.revoked_at && <> · Revoked {date(k.revoked_at)}</>}
                </div>
              </div>
              {!k.revoked_at && active.length > 1 && (
                <form action={revokeApiKey.bind(null, k.id)}>
                  <SubmitButton variant="danger" pendingText="Revoking…">{k.id === currentKeyId ? "Revoke & sign out" : "Revoke"}</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        <IssueKeyForm />
      </Card>
    </div>
  );
}

const KYC_LABEL: Record<string, string> = {
  not_started: "Not started",
  incomplete: "Incomplete",
  awaiting_ubo: "Waiting on beneficial owners",
  under_review: "Under review",
  manual_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
};

function PartnerSection({ partner, merchant }: { partner: PartnerStatus; merchant: Merchant }) {
  const started = !!partner.kyc_link_url;
  const approved = partner.kyc_status === "approved" && partner.tos_status === "approved";
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">Business verification:</span>
        <span className={approved ? "text-emerald-700 dark:text-emerald-400" : partner.kyc_status === "rejected" ? "text-red-600" : "text-amber-700 dark:text-amber-400"}>
          {KYC_LABEL[partner.kyc_status] ?? partner.kyc_status}
          {partner.tos_status !== "approved" && started ? " · terms not accepted" : ""}
        </span>
      </div>
      {!started && (
        <form action={startPartnerOnboarding}>
          <SubmitButton pendingText="Starting…">Start verification</SubmitButton>
        </form>
      )}
      {started && !approved && (
        <div className="flex flex-wrap gap-2">
          {partner.tos_status !== "approved" && partner.tos_link_url && (
            <a href={partner.tos_link_url} target="_blank" rel="noreferrer" className="rounded-md border border-zinc-300 px-3.5 py-2 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">1. Accept partner terms ↗</a>
          )}
          {partner.kyc_link_url && (
            <a href={partner.kyc_link_url} target="_blank" rel="noreferrer" className="rounded-md bg-brand px-3.5 py-2 font-medium text-brand-fg hover:bg-blue-800">2. Verify business ↗</a>
          )}
        </div>
      )}
      {approved && !partner.bank_account && <BankAccountForm idem={randomUUID()} />}
      {partner.bank_account && (
        <div className="space-y-3">
          <p>
            Payout account: <span className="font-mono">•••• {partner.bank_account.last4}</span>{" "}
            <span className="text-zinc-500">({partner.bank_account.rail.toUpperCase()}, {partner.bank_account.currency.toUpperCase()})</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <span>Receive payments as:</span>
            {(["crypto", "fiat_via_partner"] as const).map((p) => (
              <form key={p} action={setPayoutPreference.bind(null, p)}>
                <button
                  aria-pressed={merchant.payout_preference === p}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 aria-pressed:border-brand aria-pressed:bg-blue-50 aria-pressed:font-medium dark:border-zinc-700 dark:aria-pressed:bg-blue-950"
                >
                  {p === "crypto" ? "Stablecoins to my wallet" : `${partner.bank_account!.currency.toUpperCase()} to my bank`}
                </button>
              </form>
            ))}
          </div>
          {merchant.payout_preference === "fiat_via_partner" && (
            <p className="text-xs text-zinc-500">
              Stablecoin payments go to partner deposit addresses and arrive in your bank as {partner.bank_account.currency.toUpperCase()}. Active on:{" "}
              {partner.liquidation_addresses.map((l) => `${l.token} on ${l.chain}`).join(", ") || "none"}.
            </p>
          )}
        </div>
      )}
      {approved && <p className="text-xs text-zinc-500">Buyers can now choose “Bank transfer” at checkout.</p>}
    </div>
  );
}
