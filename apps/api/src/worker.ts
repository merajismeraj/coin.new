import { createDb } from "@coinnew/db";
import pino from "pino";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";
import { closeStaleIntents, processInboundEvents, recheckUnconfirmed, scanOpenIntents, type PaymentDeps } from "./services/payments.js";
import { deliverDueWebhooks } from "./services/webhooks.js";
import { processPartnerEvents, type PartnerDeps } from "./services/partners.js";
import { deliverEmails, LogSender, ResendSender } from "./services/email.js";
import { expireInvoices, sendExpiryReminders } from "./services/jobs.js";
import { purgeIdempotencyKeys } from "./plugins/idempotency.js";
import { bridgeFromConfig } from "./app.js";

// Background jobs, Postgres-backed (no Redis needed). Safe to run as several
// processes: queue-like jobs claim rows with FOR UPDATE SKIP LOCKED + leases,
// and state transitions are conditional UPDATEs that happen exactly once.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const log = pino({ name: "worker" });
const { db, close } = createDb(url);
const deps: PaymentDeps = { db, network: config.network, dashboardUrl: config.email.dashboardUrl, log, ...productionDeps(config) };
const emailSender = config.email.resendApiKey ? new ResendSender(config.email.resendApiKey) : new LogSender(log);
const partners: PartnerDeps = { db, config, log, bridge: bridgeFromConfig(config), verifier: deps.verifier, screener: deps.screener };

let stopping = false;
function every(name: string, ms: number, job: () => Promise<unknown>) {
  const tick = async () => {
    if (stopping) return;
    try {
      await job();
    } catch (err) {
      log.error({ job: name, err }, "job failed");
    }
    if (!stopping) setTimeout(tick, ms);
  };
  void tick();
}

every("inbound-events", 2_000, () => processInboundEvents(deps));
every("recheck-unconfirmed", 15_000, () => recheckUnconfirmed(deps));
every("fallback-scan", 30_000, () => scanOpenIntents(deps));
every("close-stale-intents", 5 * 60_000, () => closeStaleIntents(db));
every("partner-events", 3_000, () => processPartnerEvents(partners));
every("expire-invoices", 60_000, () => expireInvoices(db));
every("expiry-reminders", 10 * 60_000, () => sendExpiryReminders(db));
every("email-delivery", 5_000, () => deliverEmails(db, emailSender, config.email.from));
every("purge-idempotency-keys", 60 * 60_000, () => purgeIdempotencyKeys(db));
every("webhook-delivery", 5_000, () => deliverDueWebhooks(db, { allowPrivateTargets: config.webhooks.allowPrivateTargets }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopping = true;
    log.info("shutting down");
    await close();
    process.exit(0);
  });
}
log.info({ network: config.network }, "worker started");
