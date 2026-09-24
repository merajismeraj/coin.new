import type { Chain } from "@coinnew/shared-types";
import type { Config } from "../config.js";

export interface ScreeningResult {
  blocked: boolean;
  flags: string[];
}

/**
 * Sanctions screening of payer wallets. coin.new is non-custodial, but
 * knowingly facilitating payments from sanctioned addresses is still exposure
 * in most jurisdictions (OFAC, EU, UK OFSI, UN lists).
 */
export interface WalletScreener {
  screen(chain: Chain, address: string): Promise<ScreeningResult>;
}

const CLEAR: ScreeningResult = { blocked: false, flags: [] };
const norm = (chain: Chain, a: string) => (chain === "solana" ? a : a.toLowerCase());

export class DenylistScreener implements WalletScreener {
  private set: Set<string>;
  constructor(addresses: string[]) {
    this.set = new Set(addresses.flatMap((a) => [a, a.toLowerCase()]));
  }
  async screen(chain: Chain, address: string) {
    return this.set.has(norm(chain, address)) ? { blocked: true, flags: ["sanctions_match"] } : CLEAR;
  }
}

/** Chainalysis free sanctions screening API (https://go.chainalysis.com/chainalysis-sanctions-api.html). */
export class ChainalysisScreener implements WalletScreener {
  constructor(
    private apiKey: string,
    private failClosed: boolean,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async screen(_chain: Chain, address: string): Promise<ScreeningResult> {
    try {
      const res = await this.fetchImpl(`https://public.chainalysis.com/api/v1/address/${encodeURIComponent(address)}`, {
        headers: { "X-API-Key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`chainalysis ${res.status}`);
      const body = (await res.json()) as { identifications?: unknown[] };
      return body.identifications?.length ? { blocked: true, flags: ["sanctions_match"] } : CLEAR;
    } catch {
      return { blocked: this.failClosed, flags: ["screening_unavailable"] };
    }
  }
}

export class CompositeScreener implements WalletScreener {
  constructor(private screeners: WalletScreener[]) {}
  async screen(chain: Chain, address: string) {
    const results = await Promise.all(this.screeners.map((s) => s.screen(chain, address)));
    return { blocked: results.some((r) => r.blocked), flags: [...new Set(results.flatMap((r) => r.flags))] };
  }
}

export function screenerFromConfig(cfg: Config["screening"]): WalletScreener {
  const s: WalletScreener[] = [new DenylistScreener(cfg.denylist)];
  if (cfg.chainalysisApiKey) s.push(new ChainalysisScreener(cfg.chainalysisApiKey, cfg.failClosed));
  return new CompositeScreener(s);
}
