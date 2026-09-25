import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/api";

const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** Streams the CSV export through the dashboard so the API key never reaches the browser. */
export async function GET(req: Request) {
  const key = cookies().get(SESSION_COOKIE)?.value;
  if (!key) return new Response("Unauthorized", { status: 401 });
  const u = new URL(req.url);
  const day = (v: string | null, end: boolean) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`).getTime() + (end ? 86_400_000 : 0) : NaN);
  const from = day(u.searchParams.get("from"), false);
  const to = day(u.searchParams.get("to"), true);
  if (Number.isNaN(from) || Number.isNaN(to)) return new Response("Choose a valid date range", { status: 400 });
  const qs = new URLSearchParams({ format: "csv", from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  const res = await fetch(`${API_URL}/v1/reports/export?${qs}`, { headers: { authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return new Response(body?.error?.message ?? "Export failed", { status: res.status });
  }
  return new Response(res.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": res.headers.get("content-disposition") ?? 'attachment; filename="settlements.csv"',
      "cache-control": "no-store",
    },
  });
}
