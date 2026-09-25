import postgres from "postgres";
import { scheduleSupabaseCron } from "./supabase-cron.js";

const { DATABASE_URL: url, CRON_TICK_URL: tickUrl, CRON_SECRET: secret, CRON_SCHEDULE: schedule } = process.env;
if (!url || !tickUrl || !secret) throw new Error("DATABASE_URL, CRON_TICK_URL and CRON_SECRET are required");
const sql = postgres(url, { max: 1, onnotice: () => {} });
const result = await scheduleSupabaseCron(
  {
    exec: async (text) => void (await sql.unsafe(text)),
    query: async (text, params) => (await sql.unsafe(text, params as never[])) as never,
  },
  { tickUrl, secret, schedule: schedule || undefined },
);
console.log(result === "scheduled" ? `supabase cron: ${tickUrl} (${schedule || "* * * * *"})` : "supabase cron: pg_cron/pg_net unavailable; skipped");
await sql.end();
