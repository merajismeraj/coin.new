import type { BridgeApi, CreateTransferInput, ExternalAccountInput, KycLink, Transfer, TransferState } from "../src/rails/bridge.js";
import { BridgeError } from "../src/rails/bridge.js";

/** In-memory Bridge: tests drive KYB decisions and transfer states. */
export class FakeBridge implements BridgeApi {
  links = new Map<string, KycLink>();
  transfers = new Map<string, Transfer>();
  externalAccounts: { customerId: string; input: ExternalAccountInput }[] = [];
  liquidation: { customerId: string; chain: string; currency: string }[] = [];
  /** Pairs Bridge refuses to liquidate, e.g. "solana:usdt". */
  unsupported = new Set<string>();
  transferCalls: { input: CreateTransferInput; idem: string }[] = [];
  private n = 0;

  async createKycLink(input: { full_name: string; email: string }) {
    const id = `kyc_${++this.n}`;
    const link: KycLink = { id, customer_id: null, kyc_link: `https://bridge.test/kyc/${id}`, tos_link: `https://bridge.test/tos/${id}`, kyc_status: "not_started", tos_status: "pending" };
    this.links.set(id, link);
    void input;
    return { ...link };
  }
  async getKycLink(id: string) {
    const l = this.links.get(id);
    if (!l) throw new BridgeError(404, { code: "not_found" });
    return { ...l };
  }
  approve(id: string) {
    Object.assign(this.links.get(id)!, { kyc_status: "approved", tos_status: "approved", customer_id: `cus_${id}` });
  }
  async createExternalAccount(customerId: string, input: ExternalAccountInput) {
    this.externalAccounts.push({ customerId, input });
    const num = input.account_type === "us" ? input.account.account_number : input.iban.account_number;
    return { id: `ext_${++this.n}`, last_4: num.slice(-4), currency: input.currency };
  }
  async createLiquidationAddress(customerId: string, input: { chain: string; currency: string }) {
    if (this.unsupported.has(`${input.chain}:${input.currency}`)) throw new BridgeError(400, { code: "unsupported" });
    this.liquidation.push({ customerId, chain: input.chain, currency: input.currency });
    const address = input.chain === "solana" ? `So1LiQ${String(++this.n).padStart(38, "1")}` : `0x${(++this.n).toString(16).padStart(40, "b")}`;
    return { id: `liq_${this.n}`, chain: input.chain, currency: input.currency, address };
  }
  async createTransfer(input: CreateTransferInput, idem: string) {
    this.transferCalls.push({ input, idem });
    const id = `tr_${++this.n}`;
    const t: Transfer = {
      id,
      state: "awaiting_funds",
      amount: input.amount,
      currency: "usd",
      on_behalf_of: input.on_behalf_of,
      client_reference_id: input.client_reference_id,
      source: input.source,
      destination: input.destination as Transfer["destination"],
      source_deposit_instructions: {
        payment_rail: input.source.payment_rail,
        amount: input.amount,
        currency: "usd",
        deposit_message: `BRG${id.toUpperCase()}`,
        bank_name: "Lead Bank",
        bank_routing_number: "101019644",
        bank_account_number: "900000000001",
        bank_beneficiary_name: "Bridge Ventures Inc",
      },
    };
    this.transfers.set(id, t);
    return structuredClone(t);
  }
  async getTransfer(id: string) {
    return structuredClone(this.transfers.get(id)!);
  }
  setState(id: string, state: TransferState, receipt?: Transfer["receipt"]) {
    Object.assign(this.transfers.get(id)!, { state, ...(receipt && { receipt }) });
  }
}
