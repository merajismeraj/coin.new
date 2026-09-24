import "server-only";
import type { CheckoutInvoice } from "@coinnew/shared-types";

const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Public checkout read. Returns null for unknown invoices. */
export async function getCheckoutInvoice(id: string): Promise<CheckoutInvoice | null> {
  const res = await fetch(`${API_URL}/v1/checkout/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`checkout API error ${res.status}`);
  return res.json();
}
