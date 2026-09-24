import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Minimal executor so the same runner works for postgres-js and PGlite. */
export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Applies migrations/*.sql in lexical order, each once, each in a transaction. */
export async function migrate(db: SqlExecutor): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>(`SELECT name FROM _migrations`)).map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const escaped = name.replace(/'/g, "''");
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO _migrations (name) VALUES ('${escaped}');\nCOMMIT;`);
    applied.push(name);
  }
  return applied;
}
