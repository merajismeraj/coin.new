import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { migrate, type SqlExecutor } from "./migrate.js";
export { schema };

/** Driver-agnostic handle: postgres-js in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url, { max: 10 });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
