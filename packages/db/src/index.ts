import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { migrate, type SqlExecutor } from "./migrate.js";
export { scheduleSupabaseCron } from "./supabase-cron.js";
export { schema };

/** Driver-agnostic handle: postgres-js in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string, opts: { max?: number } = {}): { db: Db; close: () => Promise<void> } {
  // Transaction-mode poolers (Supabase's port 6543, Neon's "-pooler" host, PgBouncer) don't support prepared statements.
  const pooled = /:6543\/|-pooler\.|pgbouncer=true/.test(url);
  const client = postgres(url, { max: opts.max ?? 10, prepare: !pooled });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
