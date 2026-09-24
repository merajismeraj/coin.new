import { createDb } from "@coinnew/db";
import pino from "pino";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";
import { closeStaleIntents, processInboundEvents, recheckUnconfirmed, scanOpenIntents, type PaymentDeps } from "./services/payments.js";
import { deliverDueWebhooks } from "./services/webhooks.js";

// Background jobs, Postgres-backed (no Redis needed yet). Run exactly one
// worker process; jobs are idempotent but not coordinated across workers.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const log = pino({ name: "worker" });
const { db, close } = createDb(url);
const deps: PaymentDeps = { db, network: config.network, log, ...productionDeps(config) };

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
