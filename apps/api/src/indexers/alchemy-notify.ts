import type { Network } from "@coinnew/chains";
import type { Chain } from "@coinnew/shared-types";

// Alchemy Notify (webhook management) API. Authenticated with the team's
// *auth token* (dashboard → Webhooks → Auth Token), which is distinct from the
// app API key used for RPC. https://docs.alchemy.com/reference/notify-api-quickstart

/** Alchemy network ids for the EVM chains we support. */
export const ALCHEMY_NETWORKS: Record<Network, Partial<Record<Chain, string>>> = {
  mainnet: { ethereum: "ETH_MAINNET", base: "BASE_MAINNET", polygon: "MATIC_MAINNET" },
  testnet: { ethereum: "ETH_SEPOLIA", base: "BASE_SEPOLIA", polygon: "MATIC_AMOY" },
};

export const chainForAlchemyNetwork = (network: Network, alchemyNetwork: string): Chain | undefined =>
  (Object.entries(ALCHEMY_NETWORKS[network]) as [Chain, string][]).find(([, n]) => n === alchemyNetwork)?.[0];

export interface AlchemyWebhook {
  id: string;
  network: string;
  webhook_type: string;
  webhook_url: string;
  is_active: boolean;
  signing_key: string;
}

export interface AlchemyNotifyApi {
  listWebhooks(): Promise<AlchemyWebhook[]>;
  createAddressWebhook(args: { network: string; webhookUrl: string; addresses: string[] }): Promise<AlchemyWebhook>;
  updateAddresses(args: { webhookId: string; add: string[]; remove: string[] }): Promise<void>;
  /** Every address currently on the webhook (all pages). */
  listAddresses(webhookId: string): Promise<string[]>;
}

export class AlchemyNotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AlchemyNotifyClient implements AlchemyNotifyApi {
  constructor(
    private authToken: string,
    private baseUrl = "https://dashboard.alchemy.com/api",
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: { "X-Alchemy-Token": this.authToken, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new AlchemyNotifyError(res.status, `alchemy notify ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async listWebhooks() {
    return (await this.req<{ data: AlchemyWebhook[] }>("GET", "/team-webhooks")).data ?? [];
  }

  async createAddressWebhook({ network, webhookUrl, addresses }: { network: string; webhookUrl: string; addresses: string[] }) {
    const r = await this.req<{ data: AlchemyWebhook }>("POST", "/create-webhook", {
      network,
      webhook_type: "ADDRESS_ACTIVITY",
      webhook_url: webhookUrl,
      addresses,
    });
    return r.data;
  }

  async updateAddresses({ webhookId, add, remove }: { webhookId: string; add: string[]; remove: string[] }) {
    await this.req("PATCH", "/update-webhook-addresses", { webhook_id: webhookId, addresses_to_add: add, addresses_to_remove: remove });
  }

  async listAddresses(webhookId: string) {
    const out: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const qs = new URLSearchParams({ webhook_id: webhookId, limit: "100", ...(after && { after }) });
      const r = await this.req<{ data: string[]; pagination?: { cursors?: { after?: string } } }>("GET", `/webhook-addresses?${qs}`);
      out.push(...(r.data ?? []));
      after = r.pagination?.cursors?.after;
      if (!after || !r.data?.length) break;
    }
    return out;
  }
}
