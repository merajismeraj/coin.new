import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { merchants, webhookDeliveries, type Db } from "@coinnew/db";
import type { WebhookEvent, WebhookEventType } from "@coinnew/shared-types";
import { and, asc, eq, lte } from "drizzle-orm";

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

export const newSigningSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/**
 * `X-coinnew-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * Merchants recompute v1 over the raw body and reject stale timestamps.
 */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Records an event for delivery. No-op if the merchant has no webhook URL. */
export async function enqueueWebhook(db: Db, args: { merchantId: string; invoiceId: string | null; type: WebhookEventType; data: unknown }) {
  const [m] = await db.select({ url: merchants.webhookUrl }).from(merchants).where(eq(merchants.id, args.merchantId));
  if (!m?.url) return;
  const id = crypto.randomUUID();
  const event: WebhookEvent = { id, type: args.type, created_at: new Date().toISOString(), data: args.data };
  await db.insert(webhookDeliveries).values({ id, merchantId: args.merchantId, invoiceId: args.invoiceId, eventType: args.type, payload: event });
}

// ---- SSRF guard ------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Merchant-supplied URLs must not reach internal infrastructure (e.g. cloud metadata at 169.254.169.254). */
export async function assertPublicTarget(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const { hostname, protocol } = new URL(url);
  if (protocol !== "https:") throw new Error("webhook URL must be https");
  const host = hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new Error("webhook URL resolves to a private address");
}

// ---- Delivery --------------------------------------------------------------

export function nextAttemptDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

export interface DeliveryOptions {
  allowPrivateTargets: boolean;
  fetchImpl?: typeof fetch;
  batchSize?: number;
  now?: () => Date;
}

/**
 * Sends due webhooks. Retries with exponential backoff (1m, 2m, 4m … capped at
 * 6h) for up to 24h after the event, then dead-letters it as 'failed'.
 */
export async function deliverDueWebhooks(db: Db, opts: DeliveryOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now?.() ?? new Date();
  const due = await db
    .select({ d: webhookDeliveries, url: merchants.webhookUrl, secret: merchants.webhookSigningSecret })
    .from(webhookDeliveries)
    .innerJoin(merchants, eq(merchants.id, webhookDeliveries.merchantId))
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(opts.batchSize ?? 50);

  for (const { d, url, secret } of due) {
    const attempts = d.attempts + 1;
    let responseStatus: number | null = null;
    let error: string | null = null;
    try {
      if (!url || !secret) throw new Error("merchant has no webhook URL or signing secret");
      await assertPublicTarget(url, opts.allowPrivateTargets);
      const body = JSON.stringify(d.payload);
      const res = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "user-agent": "coin.new-webhooks/1",
          "x-coinnew-event-id": d.id,
          "x-coinnew-event-type": d.eventType,
          "x-coinnew-signature": signWebhook(secret, body, Math.floor(now.getTime() / 1000)),
        },
        body,
      });
      responseStatus = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }

    if (!error) {
      await db.update(webhookDeliveries).set({ status: "delivered", attempts, responseStatus, deliveredAt: now, lastError: null }).where(eq(webhookDeliveries.id, d.id));
      continue;
    }
    const next = new Date(now.getTime() + nextAttemptDelay(attempts));
    const expired = next.getTime() > d.createdAt.getTime() + RETRY_WINDOW_MS;
    await db
      .update(webhookDeliveries)
      .set({ status: expired ? "failed" : "pending", attempts, responseStatus, lastError: error, nextAttemptAt: next })
      .where(eq(webhookDeliveries.id, d.id));
  }
  return due.length;
}
