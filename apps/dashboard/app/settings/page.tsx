import { randomUUID } from "node:crypto";
import type { ApiKeySummary, Merchant } from "@coinnew/shared-types";
import { authedApi, sessionKeyId } from "@/lib/api";
import { SubmitButton } from "@/components/submit-button";
import { Card, date } from "@/components/ui";
import { RevealSecret } from "@/components/secret";
import { revokeApiKey, rotateWebhookSecret } from "../actions";
import { IssueKeyForm, ProfileForm } from "./forms";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [me, keys, webhook] = await Promise.all([
    authedApi<Merchant>("/v1/merchants/me"),
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

      <Card title="Payouts">
        <ProfileForm merchant={me} idem={randomUUID()} />
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
