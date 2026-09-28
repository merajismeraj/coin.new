import Link from "next/link";
import type { ReactNode } from "react";

const CTA = "Create your first payment link";

function PrimaryCta({ children = CTA }: { children?: ReactNode }) {
  return (
    <Link href="/onboarding" className="inline-flex items-center justify-center rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-brand-fg shadow-sm transition hover:bg-blue-800">
      {children}
    </Link>
  );
}

function Section({ id, eyebrow, title, intro, children }: { id?: string; eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 py-16 sm:py-20">
      <p className="text-sm font-semibold text-brand">{eyebrow}</p>
      <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {intro && <p className="mt-4 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">{intro}</p>}
      <div className="mt-10">{children}</div>
    </section>
  );
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{children}</p>
    </div>
  );
}

/** Illustrative checkout, drawn in HTML so it stays sharp and themable. */
function CheckoutPreview() {
  return (
    <div aria-hidden className="relative mx-auto w-full max-w-sm">
      <div className="absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-br from-blue-100 to-emerald-50 blur-2xl dark:from-blue-950 dark:to-emerald-950" />
      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-500">Northwind Studio requests</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">$4,800.00</p>
        <div className="mt-2 flex justify-between text-sm text-zinc-500">
          <span>Invoice INV-00042</span>
          <span>Expires in 3 days</span>
        </div>
        <hr className="my-5 border-zinc-100 dark:border-zinc-800" />
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1 text-center text-xs font-medium dark:bg-zinc-800">
          <span className="rounded-md bg-white py-1.5 shadow-sm dark:bg-zinc-900">Stablecoin</span>
          <span className="py-1.5 text-zinc-500">Bank transfer</span>
          <span className="py-1.5 text-zinc-500">Card</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm font-medium">
          {["Base", "Ethereum", "Polygon", "Solana"].map((n, i) => (
            <span key={n} className={`rounded-lg border px-3 py-2 text-center ${i === 0 ? "border-brand bg-blue-50 dark:bg-blue-950" : "border-zinc-200 dark:border-zinc-700"}`}>
              {n}
            </span>
          ))}
        </div>
        <div className="mt-4 rounded-lg bg-brand px-4 py-3 text-center text-sm font-semibold text-brand-fg">Pay 4,800.004213 USDC</div>
        <p className="mt-3 text-center text-xs text-zinc-500">or pay from an exchange or other wallet</p>
      </div>
      <div className="absolute -bottom-5 -right-3 flex items-center gap-2 rounded-full border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-md dark:border-emerald-900 dark:bg-zinc-900 dark:text-emerald-400 sm:-right-8">
        <span className="h-2 w-2 rounded-full bg-emerald-500" /> Paid · in your wallet
      </div>
    </div>
  );
}

const STEPS = [
  ["Add your wallet", "Paste the address where you want to be paid: a hardware wallet, a Safe multisig or your company treasury wallet. You keep the keys."],
  ["Send a payment link", "Enter the amount and your client’s email. We email the invoice and send a reminder before it expires. Or copy the link into any chat."],
  ["Get paid and reconciled", "Your client pays, we verify the payment on-chain and mark the invoice paid. You get an email, a webhook and a clean record for your books."],
] as const;

const COMPARISON = [
  ["What it costs you", "Card fees, wire charges and FX spreads", "1% flat per paid invoice"],
  ["When the money arrives", "1–5 business days", "Usually under a minute"],
  ["When you can get paid", "Bank hours", "24/7, weekends included"],
  ["Amount received", "Intermediary banks may deduct fees", "Exactly what you invoiced"],
  ["Reversals", "Card payments can be charged back", "On-chain payments are final"],
  ["Where your money sits", "With the processor until payout", "In your wallet from the first second"],
] as const;

const FAQ = [
  [
    "What does coin.new cost?",
    "1% of each paid invoice. One flat rate on every network and token, with no tiers. You pay nothing for invoices that aren’t paid. The sender covers the blockchain network fee.",
  ],
  [
    "Do my clients need crypto to pay me?",
    "They need USDC or USDT in a wallet or an exchange account such as Coinbase or Kraken. They don’t need a coin.new account. Where our licensed partners operate, clients can also pay by bank transfer or card.",
  ],
  [
    "Which stablecoins and networks do you support?",
    "USDC and USDT on Ethereum, Base, Polygon and Solana, where each token is officially issued. You choose which networks each invoice accepts. Robinhood Chain (USDG and bridged USDC) is available as an opt-in.",
  ],
  [
    "Do you ever hold my money?",
    "No. Payments go directly from your client’s wallet to yours. coin.new never holds funds and never asks for your private keys. We read the blockchain to confirm payments; we can’t move anything.",
  ],
  [
    "What if my client sends the wrong amount?",
    "The funds still land in your wallet. If a transfer doesn’t match an invoice exactly, for example because an exchange deducted its fee, it appears in your “Needs reconciliation” inbox, where you assign it to the right invoice in one click.",
  ],
  [
    "Can I get paid into my bank account instead?",
    "Yes, where available. Verify your business with our licensed partner Bridge and add a US or IBAN bank account. Payments are then converted and sent to your bank automatically.",
  ],
  [
    "Do I need a developer to use it?",
    "No. Everything works from the dashboard. When you want to automate, the API creates invoices from your billing system and signed webhooks tell it when they’re paid.",
  ],
] as const;

export function Landing() {
  return (
    <div className="-my-8">
      {/* Hero */}
      <section className="grid items-center gap-14 py-14 sm:py-20 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="inline-flex rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            Stablecoin invoicing for businesses
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Invoice anyone, anywhere. Get paid in digital dollars in minutes.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
            Send a payment link. Your client pays in USDC or USDT from their wallet or exchange, and the money lands in <strong className="font-semibold text-zinc-900 dark:text-zinc-100">your</strong> wallet,
            usually within a minute. No wires. No chargebacks. We never touch your funds.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <PrimaryCta />
            <a href="#how" className="rounded-lg px-4 py-3 text-sm font-semibold text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800">
              See how it works ↓
            </a>
          </div>
          <p className="mt-4 text-sm text-zinc-500">1% flat per paid invoice. Set up in about two minutes; all you need is a wallet address.</p>
        </div>
        <CheckoutPreview />
      </section>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-y border-zinc-200 py-5 text-sm text-zinc-500 dark:border-zinc-800">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Accept</span>
        <span>USDC</span>
        <span>USDT</span>
        <span className="font-medium text-zinc-700 dark:text-zinc-300">on</span>
        <span>Ethereum</span>
        <span>Base</span>
        <span>Polygon</span>
        <span>Solana</span>
      </div>

      <Section id="how" eyebrow="How it works" title="From invoice to paid in three steps" intro="No merchant account to apply for and no integration to build. If you can send an email, you can get paid.">
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-semibold text-brand-fg">{i + 1}</span>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <PrimaryCta />
        </div>
      </Section>

      <Section
        eyebrow="For the people paying you"
        title="Paying you takes one click, not a wire form"
        intro="Your client opens the link and sees exactly what to send. No account, no sign-up, no bank details to type."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Feature title="Any wallet, or straight from an exchange">
            Clients pay from a browser wallet like MetaMask, Rabby or Phantom. Paying from Coinbase, Kraken or a company multisig? They copy the address and amount instead.
          </Feature>
          <Feature title="The exact amount, matched automatically">
            Every checkout shows one exact amount to send. That amount identifies the payment, so there’s no memo or reference for your client to get wrong.
          </Feature>
          <Feature title="Live status, then a receipt">
            The checkout updates the moment the payment lands, and your client gets an emailed receipt. No “did you get it?” follow-ups.
          </Feature>
          <Feature title="Bank transfer or card, where available">
            Clients without stablecoins can pay by bank transfer or card through our licensed partners, Bridge and MoonPay.
          </Feature>
        </div>
      </Section>

      <Section eyebrow="Why stablecoins" title="Faster than a wire. Final like cash." intro="USDC and USDT are digital dollars that track the US dollar one-to-one. Here’s what changes when your clients pay with them.">
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
                <th className="px-5 py-3 font-medium text-zinc-500" />
                <th className="px-5 py-3 font-medium text-zinc-500">Wire or card</th>
                <th className="px-5 py-3 font-semibold text-brand">coin.new</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {COMPARISON.map(([row, old, ours]) => (
                <tr key={row}>
                  <td className="px-5 py-3 font-medium">{row}</td>
                  <td className="px-5 py-3 text-zinc-500">{old}</td>
                  <td className="px-5 py-3 font-medium">{ours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-zinc-500">Arrival time depends on the network your client picks. The sender pays the network fee, often a few cents.</p>
      </Section>

      <Section eyebrow="For finance teams" title="Reconciliation that does itself" intro="Every payment is tied to its invoice before it reaches your inbox.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Feature title="Automatic matching">Payments are verified on-chain and matched to their invoice. Short or unexpected transfers go to a review inbox, not a spreadsheet.</Feature>
          <Feature title="Emails that chase for you">Clients get the invoice, a reminder before it expires and a receipt. You get notified the moment you’re paid.</Feature>
          <Feature title="Accountant-ready exports">Download confirmed payments as CSV, with invoice numbers, amounts, networks and transaction IDs.</Feature>
          <Feature title="Your balance at a glance">See the stablecoins in your receiving wallets across every network, in one total.</Feature>
          <Feature title="API and webhooks">Create invoices from your billing system and get signed webhooks when they’re paid. Idempotent by design.</Feature>
          <Feature title="Cash out to your bank">Where available, payments are converted and paid out to your US or IBAN bank account through Bridge.</Feature>
        </div>
      </Section>

      <Section eyebrow="Security" title="Your money never touches us">
        <div className="grid gap-4 md:grid-cols-3">
          <Feature title="Non-custodial by design">Payments go from your client’s wallet straight to yours. We never hold funds and never ask for your keys. There’s nothing of yours for us to freeze.</Feature>
          <Feature title="Verified on the blockchain">An invoice is marked paid only after we read the payment from the chain itself, with the confirmations each network needs.</Feature>
          <Feature title="Screened and compliant">Paying wallets are screened against sanctions lists. Bank and card payments run through licensed partners.</Feature>
        </div>
      </Section>

      <Section id="pricing" eyebrow="Pricing" title="1% flat. You pay only when you get paid.">
        <div className="grid gap-6 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900 sm:p-8 md:grid-cols-[1fr_1.3fr] md:items-center">
          <div>
            <p className="text-6xl font-semibold tracking-tight">1%</p>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">per paid invoice</p>
            <p className="mt-5 rounded-lg bg-zinc-50 px-4 py-3 text-sm dark:bg-zinc-800/60">
              A <strong>$10,000</strong> invoice costs <strong>$100</strong>. An invoice that’s never paid costs nothing.
            </p>
            <div className="mt-6">
              <PrimaryCta>Get started</PrimaryCta>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold">Everything included</p>
            <ul className="mt-3 grid gap-2 text-sm text-zinc-700 dark:text-zinc-300 sm:grid-cols-2">
              {[
                "Unlimited invoices and payment links",
                "USDC and USDT on every supported network",
                "Invoice, reminder and receipt emails",
                "Automatic matching and reconciliation",
                "CSV exports for your accountant",
                "API and signed webhooks",
              ].map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                  {f}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs leading-relaxed text-zinc-500">
              Blockchain network fees are paid by the sender. Card payments and bank payouts run through licensed partners, whose own fees are shown before you or your client confirm.
            </p>
          </div>
        </div>
      </Section>

      <Section id="faq" eyebrow="FAQ" title="Questions, answered">
        <div className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {q}
                <span className="text-zinc-400 transition group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{a}</p>
            </details>
          ))}
        </div>
      </Section>

      <section className="mb-8 rounded-2xl bg-zinc-900 px-6 py-12 text-center text-white dark:bg-zinc-100 dark:text-zinc-900 sm:px-12">
        <h2 className="text-3xl font-semibold tracking-tight">Send your first payment link today</h2>
        <p className="mx-auto mt-3 max-w-lg text-zinc-300 dark:text-zinc-600">Add a wallet, enter an amount and share the link. Your client can pay you in the next five minutes.</p>
        <div className="mt-7">
          <PrimaryCta>Get started</PrimaryCta>
        </div>
        <p className="mt-4 text-sm text-zinc-400 dark:text-zinc-500">
          Already have an account?{" "}
          <Link href="/login" className="font-medium underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </section>
    </div>
  );
}
