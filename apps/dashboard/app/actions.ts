"use server";

import type { CreateMerchantResponse, Invoice, IssuedApiKey, Merchant } from "@coinnew/shared-types";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api, ApiRequestError, authedApi, clearSession, sessionKeyId, setSession, toFormState, type FormState } from "@/lib/api";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};

// ---- Session ---------------------------------------------------------------

export type OnboardState = FormState & { issuedKey?: string };

export async function onboard(_: OnboardState, form: FormData): Promise<OnboardState> {
  try {
    const res = await api<CreateMerchantResponse>("/v1/merchants", {
      method: "POST",
      key: null,
      idem: str(form, "idem"),
      body: {
        business_name: str(form, "business_name"),
        email: str(form, "email"),
        country_code: str(form, "country_code"),
        receiving_wallets: { evm: str(form, "evm_wallet") ?? null, solana: str(form, "solana_wallet") ?? null },
      },
    });
    setSession(res.api_key.key);
    // Returned to the client once so the merchant can store it; never persisted by the dashboard beyond the httpOnly session.
    return { issuedKey: res.api_key.key };
  } catch (e) {
    return toFormState(e);
  }
}

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const key = str(form, "api_key") ?? "";
  try {
    await api<Merchant>("/v1/merchants/me", { key });
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) return { error: "That API key is invalid or has been revoked." };
    throw e;
  }
  setSession(key);
  redirect("/");
}

export async function logout() {
  clearSession();
  redirect("/login");
}

// ---- Invoices --------------------------------------------------------------

export async function createInvoice(_: FormState, form: FormData): Promise<FormState> {
  let invoice: Invoice;
  const hours = str(form, "expires_in_hours");
  const po = str(form, "po_number");
  try {
    invoice = await authedApi<Invoice>("/v1/invoices", {
      method: "POST",
      idem: str(form, "idem"),
      body: {
        amount_usd: str(form, "amount_usd"),
        invoice_number: str(form, "invoice_number"),
        buyer_email: str(form, "buyer_email"),
        accepted_tokens: form.getAll("accepted_tokens"),
        accepted_chains: form.getAll("accepted_chains"),
        expires_in_hours: hours ? Number(hours) : undefined,
        metadata: po ? { po_number: po } : {},
        notify_buyer: form.get("notify_buyer") === "on",
      },
    });
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath("/");
  redirect(`/invoices/${invoice.id}`);
}

export async function cancelInvoice(id: string) {
  await authedApi(`/v1/invoices/${id}/cancel`, { method: "POST" });
  revalidatePath(`/invoices/${id}`);
  revalidatePath("/");
}

// ---- Settings --------------------------------------------------------------

export async function updateMerchant(_: FormState & { saved?: boolean }, form: FormData): Promise<FormState & { saved?: boolean }> {
  try {
    await authedApi<Merchant>("/v1/merchants/me", {
      method: "PATCH",
      idem: str(form, "idem"),
      body: {
        receiving_wallets: { evm: str(form, "evm_wallet") ?? null, solana: str(form, "solana_wallet") ?? null },
        // Chains for a wallet family that was just added are enabled server-side.
        ...(form.getAll("preferred_chains").length && { preferred_chains: form.getAll("preferred_chains") }),
        webhook_url: str(form, "webhook_url") ?? null,
      },
    });
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath("/settings");
  return { saved: true, idem: crypto.randomUUID() };
}

export type IssueKeyState = FormState & { issuedKey?: string };

export async function issueApiKey(_: IssueKeyState, form: FormData): Promise<IssueKeyState> {
  try {
    const key = await authedApi<IssuedApiKey>("/v1/merchants/me/api-keys", { method: "POST", body: { label: str(form, "label") } });
    revalidatePath("/settings");
    return { issuedKey: key.key };
  } catch (e) {
    return toFormState(e);
  }
}

export async function revokeApiKey(id: string) {
  const isSessionKey = id === sessionKeyId();
  try {
    await authedApi(`/v1/merchants/me/api-keys/${id}`, { method: "DELETE" });
  } catch (e) {
    if (!(e instanceof ApiRequestError && e.code === "last_api_key")) throw e;
    return revalidatePath("/settings");
  }
  if (isSessionKey) {
    // This browser was signed in with the key just revoked.
    clearSession();
    redirect("/login");
  }
  revalidatePath("/settings");
}

export async function rotateWebhookSecret() {
  await authedApi("/v1/merchants/me/webhook-secret/rotate", { method: "POST" });
  revalidatePath("/settings");
}

// ---- Partner payouts (Bridge) ------------------------------------------------

export async function startPartnerOnboarding() {
  await authedApi("/v1/merchants/me/partner/onboarding", { method: "POST", body: {} });
  revalidatePath("/settings");
}

export async function addBankAccount(_: FormState, form: FormData): Promise<FormState & { saved?: boolean }> {
  const type = str(form, "account_type");
  const body =
    type === "iban"
      ? { account_type: "iban", account_owner_name: str(form, "account_owner_name"), iban: str(form, "iban")?.replace(/\s+/g, ""), bic: str(form, "bic"), country: str(form, "country") }
      : {
          account_type: "us",
          bank_name: str(form, "bank_name"),
          account_owner_name: str(form, "account_owner_name"),
          account_number: str(form, "account_number"),
          routing_number: str(form, "routing_number"),
          checking_or_savings: str(form, "checking_or_savings") ?? "checking",
          rail: str(form, "rail") ?? "ach",
          address: { street_line_1: str(form, "street"), city: str(form, "city"), state: str(form, "state"), postal_code: str(form, "postal_code"), country: str(form, "country") },
        };
  try {
    await authedApi("/v1/merchants/me/partner/bank-account", { method: "POST", idem: str(form, "idem"), body });
  } catch (e) {
    return toFormState(e);
  }
  revalidatePath("/settings");
  return { saved: true };
}

export async function setPayoutPreference(pref: "crypto" | "fiat_via_partner") {
  try {
    await authedApi("/v1/merchants/me", { method: "PATCH", body: { payout_preference: pref } });
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    redirect(`/settings?error=${encodeURIComponent(e.message)}`);
  }
  revalidatePath("/settings");
  redirect("/settings");
}

// ---- Reconciliation (Phase 4) ------------------------------------------------

export async function resendInvoice(id: string) {
  try {
    await authedApi(`/v1/invoices/${id}/resend`, { method: "POST" });
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    redirect(`/invoices/${id}?notice=${encodeURIComponent(e.message)}`);
  }
  redirect(`/invoices/${id}?notice=${encodeURIComponent("Invoice sent to the buyer again.")}`);
}

export async function assignTransfer(id: string, form: FormData) {
  const invoiceId = str(form, "invoice_id");
  try {
    await authedApi(`/v1/unmatched-transfers/${id}/assign`, { method: "POST", body: { invoice_id: invoiceId } });
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    redirect(`/payments?error=${encodeURIComponent(e.message)}`);
  }
  revalidatePath("/payments");
  redirect(`/invoices/${invoiceId}`);
}

export async function dismissTransfer(id: string) {
  await authedApi(`/v1/unmatched-transfers/${id}/dismiss`, { method: "POST" });
  revalidatePath("/payments");
}
