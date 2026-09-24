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
        default_receiving_wallet: str(form, "default_receiving_wallet"),
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
        default_receiving_wallet: str(form, "default_receiving_wallet"),
        preferred_chains: form.getAll("preferred_chains"),
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
