import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Pay invoice — coin.new", robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">{children}</main>
      </body>
    </html>
  );
}
