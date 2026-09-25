import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb } from "@coinnew/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";

// Vercel Function entry. One Fastify instance per warm function, reused across
// invocations; background jobs run from Supabase Cron via /internal/cron/tick.

// POSTGRES_URL: the pooled connection Supabase's Vercel integration provides.
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is required");

const config = loadConfig();
const { db } = createDb(url, { max: 5 });
const app = await buildApp({ db, config, ...productionDeps(config) });
await app.ready();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  app.server.emit("request", req, res);
}
