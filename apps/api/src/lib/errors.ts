import type { ZodType, z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parse<S extends ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new HttpError(400, "validation_error", "Request validation failed", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

/** Postgres unique_violation, unwrapping driver/ORM error wrappers. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === "23505") return true;
  return false;
}
