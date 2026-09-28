import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { BillingSummary } from "@coinnew/shared-types";
import { BillingBanner } from "@/components/billing";
import { api } from "@/lib/api";
import { logout } from "./actions";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "coin.new — Invoice anyone. Get paid in stablecoins.", template: "%s · coin.new" },
  description: "Send a payment link and get paid in USDC or USDT straight to your own wallet, usually within a minute. Non-custodial invoicing for businesses.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = cookies().has("cn_session");
  // Never let a billing lookup break the page.
  const billing = signedIn ? await api<BillingSummary>("/v1/merchants/me/billing").catch(() => null) : null;
  return (
    <html lang="en">
      <body className="font-sans">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
            <Link href="/" className="font-semibold tracking-tight">
              coin<span className="text-brand">.new</span>
            </Link>
            {signedIn ? (
              <nav className="flex items-center gap-4 text-sm sm:gap-5">
                <Link href="/" className="hover:text-brand">Invoices</Link>
                <Link href="/payments" className="hover:text-brand">Payments</Link>
                <Link href="/settings" className="hover:text-brand">Settings</Link>
                <Link href="/invoices/new" className="hidden rounded-md bg-brand px-3 py-1.5 font-medium text-brand-fg hover:bg-blue-800 sm:inline-flex">
                  New invoice
                </Link>
                <form action={logout}>
                  <button className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Sign out</button>
                </form>
              </nav>
            ) : (
              <nav className="flex items-center gap-4 text-sm sm:gap-5">
                <Link href="/#how" className="hidden hover:text-brand sm:inline">How it works</Link>
                <Link href="/#pricing" className="hidden hover:text-brand sm:inline">Pricing</Link>
                <Link href="/#faq" className="hidden hover:text-brand sm:inline">FAQ</Link>
                <Link href="/login" className="hover:text-brand">Sign in</Link>
                <Link href="/onboarding" className="rounded-md bg-brand px-3 py-1.5 font-medium text-brand-fg hover:bg-blue-800">Get started</Link>
              </nav>
            )}
          </div>
        </header>
        {billing && <BillingBanner billing={billing} />}
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        {!signedIn && (
          <footer className="border-t border-zinc-200 dark:border-zinc-800">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-zinc-500">
              <span>
                coin<span className="text-brand">.new</span> · Non-custodial stablecoin invoicing
              </span>
              <span>We never hold your funds or your keys.</span>
            </div>
          </footer>
        )}
      </body>
    </html>
  );
}
