import { proxy } from "@/lib/api";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return proxy(req, `/v1/checkout/${encodeURIComponent(params.id)}/onchain-intent`, { method: "POST", body: await req.text() });
}
