import type { SqlExecutor } from "./migrate.js";

export const CRON_JOB_NAME = "coinnew-tick";
export const CRON_SECRET_NAME = "coinnew_cron_secret";

/**
 * Supabase Cron: pg_cron calls the API's job runner over HTTP (pg_net) on a
 * schedule, with the bearer secret held in Supabase Vault rather than in the
 * job's command text. Idempotent: re-running updates the secret, URL and
 * schedule in place.
 *
 * Returns "skipped" on a database without pg_cron/pg_net (not Supabase).
 */
export async function scheduleSupabaseCron(
  sql: SqlExecutor,
  { tickUrl, secret, schedule = "* * * * *" }: { tickUrl: string; secret: string; schedule?: string },
): Promise<"scheduled" | "skipped"> {
  const available = await sql.query<{ name: string }>("select name from pg_available_extensions where name in ('pg_cron', 'pg_net')");
  if (available.length < 2) return "skipped";
  await sql.exec("create extension if not exists pg_cron");
  await sql.exec("create extension if not exists pg_net with schema extensions");

  const [existing] = await sql.query<{ id: string }>("select id from vault.secrets where name = $1", [CRON_SECRET_NAME]);
  if (existing) await sql.query("select vault.update_secret($1, $2)", [existing.id, secret]);
  else await sql.query("select vault.create_secret($1, $2)", [secret, CRON_SECRET_NAME]);

  // %L quotes the URL and secret name as SQL literals. The secret itself is read
  // from Vault each run, so it never appears in cron.job.
  await sql.query(
    `select cron.schedule($1, $2, format(
       'select net.http_get(url := %L, headers := jsonb_build_object(''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = %L)), timeout_milliseconds := 55000)',
       $3::text, $4::text))`,
    [CRON_JOB_NAME, schedule, tickUrl, CRON_SECRET_NAME],
  );
  return "scheduled";
}
