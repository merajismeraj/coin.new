import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Job } from "../jobs.js";
import { runJobsOnce } from "../jobs.js";
import { HttpError } from "../lib/errors.js";

/** Leaves headroom under the function's 60s limit. */
const BUDGET_MS = 50_000;

/**
 * Serverless job runner: Vercel Cron calls this (GET, `Authorization: Bearer
 * $CRON_SECRET`) and every worker job runs once. Registered only when
 * CRON_SECRET is set; an always-on deployment uses src/worker.ts instead.
 */
export async function cronRoutes(app: FastifyInstance, { secret, jobs }: { secret: string; jobs: Job[] }) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const opts = { config: { idempotency: false as const, rateLimit: false as const } };
  const tick = async (auth: string | undefined) => {
    const given = Buffer.from(auth ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, "unauthorized", "Invalid cron secret");
    return { ran_at: new Date().toISOString(), jobs: await runJobsOnce(jobs, { budgetMs: BUDGET_MS, log: app.log }) };
  };
  app.get("/internal/cron/tick", opts, (req) => tick(req.headers.authorization));
  app.post("/internal/cron/tick", opts, (req) => tick(req.headers.authorization));
}
