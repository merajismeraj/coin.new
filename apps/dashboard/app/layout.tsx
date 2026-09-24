import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { logout } from "./actions";
import "./globals.css";

export const metadata: Metadata = { title: "coin.new — Dashboard", description: "Stablecoin invoicing, non-custodial." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = cookies().has("cn_session");
  return (
    <html lang="en">
      <body className="font-sans">
        <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
            <Link href="/" className="font-semibold tracking-tight">
              coin<span className="text-brand">.new</span>
            </Link>
            {signedIn && (
              <nav className="flex items-center gap-5 text-sm">
                <Link href="/" className="hover:text-brand">Invoices</Link>
                <Link href="/settings" className="hover:text-brand">Settings</Link>
                <form action={logout}>
                  <button className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Sign out</button>
                </form>
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
