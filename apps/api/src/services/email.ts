import { emailOutbox, type Db } from "@coinnew/db";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

// Transactional email via an outbox: callers enqueue rows inside their own
// flow; the worker delivers with retries. Sending never blocks a request.

export type EmailTemplate = "invoice_issued" | "invoice_reminder" | "payment_receipt" | "payment_received_merchant";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(msg: EmailMessage & { from: string; idempotencyKey: string }): Promise<{ id: string }>;
}

/** Resend (resend.com) HTTP API. */
export class ResendSender implements EmailSender {
  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(msg: EmailMessage & { from: string; idempotencyKey: string }) {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": msg.idempotencyKey },
      body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`resend ${res.status}: ${body.message ?? "error"}`);
    return { id: body.id ?? "" };
  }
}

/** Development fallback: logs instead of sending. */
export class LogSender implements EmailSender {
  constructor(private log: { info: (o: object, m: string) => void }) {}
  async send(msg: EmailMessage) {
    this.log.info({ to: msg.to, subject: msg.subject }, "email (not sent: RESEND_API_KEY unset)");
    return { id: "logged" };
  }
}

export async function enqueueEmail(db: Db, e: EmailMessage & { template: EmailTemplate; merchantId: string | null; invoiceId: string | null }) {
  await db.insert(emailOutbox).values({
    template: e.template,
    merchantId: e.merchantId,
    invoiceId: e.invoiceId,
    toAddress: e.to,
    subject: e.subject.slice(0, 200),
    html: e.html,
    text: e.text,
  });
}

const RETRY_WINDOW_MS = 24 * 3600_000;
const LEASE_MS = 2 * 60_000;

/**
 * Claims due rows with FOR UPDATE SKIP LOCKED and a lease, so any number of
 * workers can run this concurrently without double-sending.
 */
export async function deliverEmails(db: Db, sender: EmailSender, from: string, batch = 25): Promise<number> {
  const now = new Date();
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, "pending"), lte(emailOutbox.nextAttemptAt, now)))
      .orderBy(asc(emailOutbox.nextAttemptAt))
      .limit(batch)
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    return tx
      .update(emailOutbox)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(emailOutbox.id, rows.map((r) => r.id)))
      .returning();
  });

  for (const e of claimed) {
    const attempts = e.attempts + 1;
    try {
      // The outbox id doubles as the provider idempotency key: a retry after an ambiguous failure can't double-send.
      const r = await sender.send({ from, to: e.toAddress, subject: e.subject, html: e.html, text: e.text, idempotencyKey: e.id });
      await db.update(emailOutbox).set({ status: "sent", attempts, providerId: r.id, sentAt: new Date(), lastError: null }).where(eq(emailOutbox.id, e.id));
    } catch (err) {
      const next = new Date(Date.now() + Math.min(60_000 * 2 ** (attempts - 1), 3 * 3600_000));
      const dead = next.getTime() > e.createdAt.getTime() + RETRY_WINDOW_MS;
      await db
        .update(emailOutbox)
        .set({ status: dead ? "failed" : "pending", attempts, lastError: (err as Error).message.slice(0, 500), nextAttemptAt: next })
        .where(eq(emailOutbox.id, e.id));
    }
  }
  return claimed.length;
}

/** Emails of a template sent (or queued) for an invoice within a window, for throttling. */
export async function recentEmails(db: Db, invoiceId: string, template: EmailTemplate, sinceMs: number) {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.invoiceId, invoiceId), eq(emailOutbox.template, template), sql`${emailOutbox.createdAt} > now() - make_interval(secs => ${sinceMs / 1000})`));
  return r?.n ?? 0;
}
