import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./index.js";
import { migrate } from "./migrate.js";
import * as schema from "./schema.js";

/** In-process Postgres with migrations applied. No external database needed. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  await migrate({
    exec: async (sql) => void (await pg.exec(sql)),
    query: async (sql, params) => (await pg.query(sql, params)).rows as never,
  });
  return { db: drizzle(pg, { schema }) as unknown as Db, close: () => pg.close() };
}
