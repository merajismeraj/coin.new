import type { Db } from "@coinnew/db";
import { and, asc, inArray, isNull, lte } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

type EventTable = PgTable & { id: PgColumn; processedAt: PgColumn; nextAttemptAt: PgColumn };

const LEASE_MS = 2 * 60_000;

/**
 * Claims up to `limit` due, unprocessed rows for this worker: locks them with
 * FOR UPDATE SKIP LOCKED and pushes next_attempt_at forward as a lease, so
 * concurrent workers never pick the same row. A crashed worker's rows become
 * due again when the lease lapses.
 */
export async function claimDue<T extends EventTable>(db: Db, table: T, limit: number): Promise<T["$inferSelect"][]> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: table.id })
      .from(table as PgTable)
      .where(and(isNull(table.processedAt), lte(table.nextAttemptAt, now)))
      .orderBy(asc(table.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    return (await tx
      .update(table as PgTable)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) } as never)
      .where(inArray(table.id, rows.map((r) => r.id as string)))
      .returning()) as T["$inferSelect"][];
  });
}
