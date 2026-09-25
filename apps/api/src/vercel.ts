import type { IncomingMessage, ServerResponse } from "node:http";
import { createDb } from "@coinnew/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";

// Vercel Function entry. One Fastify instance per warm function, reused across
// invocations; background jobs run from Vercel Cron via /internal/cron/tick.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const { db } = createDb(url, { max: 5 });
const app = await buildApp({ db, config, ...productionDeps(config) });
await app.ready();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  app.server.emit("request", req, res);
}
