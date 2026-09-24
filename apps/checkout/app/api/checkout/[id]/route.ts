import { proxy } from "@/lib/api";

export const dynamic = "force-dynamic";

export function GET(req: Request, { params }: { params: { id: string } }) {
  return proxy(req, `/v1/checkout/${encodeURIComponent(params.id)}`, { method: "GET" });
}
