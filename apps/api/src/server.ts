import { createDb } from "@coinnew/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { productionDeps } from "./deps.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const config = loadConfig();
const { db, close } = createDb(url);
const app = await buildApp({ db, config, ...productionDeps(config) });
app.addHook("onClose", close);
await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
