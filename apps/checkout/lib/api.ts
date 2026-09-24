import "server-only";
import type { CheckoutInvoice } from "@coinnew/shared-types";

export const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Public checkout read. Returns null for unknown invoices. */
export async function getCheckoutInvoice(id: string): Promise<CheckoutInvoice | null> {
  const res = await fetch(`${API_URL}/v1/checkout/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`checkout API error ${res.status}`);
  return res.json();
}

/** Forwards a browser request to the API, passing the buyer's IP for per-IP rate limiting. */
export async function proxy(req: Request, path: string, init: { method: "GET" | "POST"; body?: string }) {
  const fwd = req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip");
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method,
    body: init.body,
    cache: "no-store",
    headers: { ...(init.body && { "content-type": "application/json" }), ...(fwd && { "x-forwarded-for": fwd }) },
  });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
