import { createDb } from "@coinnew/db";
import pino from "pino";
import { bridgeFromConfig } from "./app.js";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";
import { buildJobs } from "./jobs.js";
import type { PartnerDeps } from "./services/partners.js";
import type { PaymentDeps } from "./services/payments.js";

// Always-on worker for server deployments. Serverless deployments run the same
// jobs from the cron tick (/internal/cron/tick) instead.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const log = pino({ name: "worker" });
const { db, close } = createDb(url);
const payments: PaymentDeps = { db, network: config.network, dashboardUrl: config.email.dashboardUrl, log, ...productionDeps(config) };
const partners: PartnerDeps = { db, config, log, bridge: bridgeFromConfig(config), verifier: payments.verifier, screener: payments.screener };

let stopping = false;
for (const job of buildJobs({ db, config, payments, partners, log })) {
  const tick = async () => {
    if (stopping) return;
    try {
      await job.run();
    } catch (err) {
      log.error({ job: job.name, err }, "job failed");
    }
    if (!stopping) setTimeout(tick, job.everyMs);
  };
  void tick();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopping = true;
    log.info("shutting down");
    await close();
    process.exit(0);
  });
}
log.info({ network: config.network }, "worker started");
