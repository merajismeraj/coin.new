import type { Db } from "@coinnew/db";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { AlchemyNotifyClient } from "./indexers/alchemy-notify.js";
import { purgeIdempotencyKeys } from "./plugins/idempotency.js";
import { syncAlchemyAddresses } from "./services/alchemy-sync.js";
import { deliverEmails, LogSender, ResendSender } from "./services/email.js";
import { expireInvoices, sendExpiryReminders } from "./services/jobs.js";
import { processPartnerEvents, type PartnerDeps } from "./services/partners.js";
import { closeStaleIntents, processInboundEvents, recheckUnconfirmed, scanOpenIntents, type PaymentDeps } from "./services/payments.js";
import { deliverDueWebhooks } from "./services/webhooks.js";

export interface Job {
  name: string;
  /** How often the always-on worker runs it. The cron tick runs every job each time it fires. */
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Every background job, shared by the always-on worker (src/worker.ts) and the
 * serverless cron tick (/internal/cron/tick). All are safe to run concurrently
 * and repeatedly: queues claim rows with FOR UPDATE SKIP LOCKED + leases, and
 * state transitions are conditional UPDATEs.
 */
export function buildJobs(d: { db: Db; config: Config; payments: PaymentDeps; partners: PartnerDeps; log: FastifyBaseLogger }): Job[] {
  const { db, config, payments, partners, log } = d;
  const emailSender = config.email.resendApiKey ? new ResendSender(config.email.resendApiKey) : new LogSender(log);
  return [
    { name: "inbound-events", everyMs: 2_000, run: () => processInboundEvents(payments) },
    { name: "partner-events", everyMs: 3_000, run: () => processPartnerEvents(partners) },
    { name: "recheck-unconfirmed", everyMs: 15_000, run: () => recheckUnconfirmed(payments) },
    { name: "fallback-scan", everyMs: 30_000, run: () => scanOpenIntents(payments) },
    { name: "webhook-delivery", everyMs: 5_000, run: () => deliverDueWebhooks(db, { allowPrivateTargets: config.webhooks.allowPrivateTargets }) },
    { name: "email-delivery", everyMs: 5_000, run: () => deliverEmails(db, emailSender, config.email.from) },
    { name: "expire-invoices", everyMs: 60_000, run: () => expireInvoices(db) },
    { name: "expiry-reminders", everyMs: 10 * 60_000, run: () => sendExpiryReminders(db) },
    { name: "close-stale-intents", everyMs: 5 * 60_000, run: () => closeStaleIntents(db) },
    {
      name: "alchemy-address-sync",
      everyMs: 30_000,
      run: () =>
        syncAlchemyAddresses({
          db,
          network: config.network,
          api: config.indexers.alchemyNotify ? new AlchemyNotifyClient(config.indexers.alchemyNotify.authToken) : null,
          webhookUrl: config.indexers.alchemyNotify?.webhookUrl ?? null,
          log,
        }),
    },
    { name: "purge-idempotency-keys", everyMs: 60 * 60_000, run: () => purgeIdempotencyKeys(db) },
  ];
}

/** Runs each job once, in order, stopping before the time budget runs out. One failure never stops the rest. */
export async function runJobsOnce(jobs: Job[], opts: { budgetMs: number; log: FastifyBaseLogger; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.budgetMs;
  const results: Record<string, "ok" | "failed" | "skipped"> = {};
  for (const job of jobs) {
    if (now() >= deadline) {
      results[job.name] = "skipped";
      continue;
    }
    try {
      await job.run();
      results[job.name] = "ok";
    } catch (err) {
      opts.log.error({ job: job.name, err }, "job failed");
      results[job.name] = "failed";
    }
  }
  return results;
}
