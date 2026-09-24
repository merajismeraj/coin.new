import "server-only";
import { randomUUID } from "node:crypto";
import type { ApiError } from "@coinnew/shared-types";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const SESSION_COOKIE = "cn_session";
const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

interface Options {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Idempotency-Key; generated if omitted on a mutating call. */
  idem?: string;
  /** Override the session key (onboarding/login, before the cookie exists). */
  key?: string | null;
}

/**
 * Server-side client for the coin.new API. The merchant API key lives only in
 * an httpOnly cookie and is never sent to the browser.
 *
 * Phase 1 stand-in for Clerk/Supabase Auth (spec §5.7): the dashboard session
 * *is* the API key. Swap for a real session provider before GA.
 */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const key = opts.key === undefined ? cookies().get(SESSION_COOKIE)?.value : opts.key;
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = opts.idem ?? randomUUID();

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!res.ok) {
    const err = json?.error;
    throw new ApiRequestError(res.status, err?.code ?? "unknown", err?.message ?? `API error ${res.status}`, err?.details as never);
  }
  return json as T;
}

/** Like api(), but sends the user back to /login when the key is missing or revoked. */
export async function authedApi<T>(path: string, opts: Omit<Options, "key"> = {}): Promise<T> {
  try {
    return await api<T>(path, opts);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) redirect("/login?expired=1");
    throw e;
  }
}

export function setSession(key: string) {
  cookies().set(SESSION_COOKIE, key, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export const clearSession = () => cookies().delete(SESSION_COOKIE);

/** The API key id embedded in the session key (cn_<32 hex id>_<secret>), as a UUID. */
export function sessionKeyId(): string | null {
  const m = /^cn_([0-9a-f]{32})_/.exec(cookies().get(SESSION_COOKIE)?.value ?? "");
  if (!m) return null;
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Shape returned to useFormState on failure. `idem` is fresh so a corrected resubmit isn't rejected as a key reuse. */
export interface FormState {
  error?: string;
  fields?: Record<string, string>;
  idem?: string;
}

export function toFormState(e: unknown): FormState {
  const idem = randomUUID();
  if (e instanceof ApiRequestError) {
    const fields = Object.fromEntries((e.details ?? []).map((d) => [d.path.split(".")[0] ?? "", d.message]));
    return { error: e.message, fields, idem };
  }
  throw e;
}
