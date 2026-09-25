# coin.new

Non-custodial stablecoin payment orchestration for cross-border B2B invoicing.

> **Core invariant.** coin.new never holds, nets, or controls user funds. Buyers pay
> wallet-to-wallet (or via a licensed partner rail) straight to the merchant. The
> backend holds no keys that can move funds, and the ledger is a read-only mirror of
> chain/partner events. `scripts/custody-guard.mjs` enforces this in CI on every PR.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Turborepo monorepo, CI, custody guard | ✅ |
| 1 | Merchant onboarding + API keys, invoice CRUD, dashboard, read-only checkout | ✅ |
| 2 | Wallet connect, direct USDC/USDT transfer, Alchemy/Helius matching, merchant webhooks | ✅ |
| 3 | Partner rail (Bridge/Circle) fiat on-ramp, MoonPay fallback, fiat payout | ✅ |
| 4 | Settlements API, CSV export, expiry jobs, resend + email | ✅ |
| 5 | Optional audited forwarder contract | — |

## Layout

```
apps/api          Fastify REST API + background worker (src/worker.ts)
apps/dashboard    Next.js 14 merchant dashboard           :3000
apps/checkout     Next.js 14 hosted buyer checkout        :3001
packages/db       SQL migrations + Drizzle schema (Postgres; PGlite for tests)
packages/chains   Chain/token registry, amount math, read-only chain verifier (viem, @solana/web3.js)
packages/shared-types  Zod schemas and API types shared by all apps
scripts/custody-guard.mjs  CI rule: no signers, key material, or custody-shaped tables
```

## Running locally

```bash
pnpm install
cp .env.example .env            # then export the vars, or set them per app
createdb coinnew
DATABASE_URL=postgres://… pnpm db:migrate

DATABASE_URL=postgres://… CHECKOUT_BASE_URL=http://localhost:3001 pnpm --filter @coinnew/api dev
DATABASE_URL=postgres://… pnpm --filter @coinnew/api worker        # payment matching + webhook delivery
API_URL=http://localhost:4000 pnpm --filter @coinnew/dashboard dev
API_URL=http://localhost:4000 pnpm --filter @coinnew/checkout dev
```

Open http://localhost:3000, create a merchant, save the API key shown once, create an invoice,
and open its checkout link.

## Checks

```bash
pnpm lint        # custody guard + its tests + ESLint
pnpm typecheck
pnpm test        # API integration tests on in-process Postgres (no DB needed)
pnpm build
```

## API

All authenticated routes take `Authorization: Bearer <api key>`. Every `POST`/`PATCH`/`DELETE`
requires `Idempotency-Key`; a repeat within 24h replays the original response (responses that
contain a one-time API key are replayed with the key redacted, so plaintext keys are never
stored). Limits: 100 writes/min and 1000 reads/min per key.

| Method | Path | |
|---|---|---|
| POST | `/v1/merchants` | Onboard; returns the first API key once |
| GET / PATCH | `/v1/merchants/me` | Profile; wallet, chains, webhook URL |
| GET | `/v1/merchants/me/holdings` | Stablecoins in the merchant's own receiving wallets, read from chain |
| GET / POST | `/v1/merchants/me/api-keys` | List / issue |
| DELETE | `/v1/merchants/me/api-keys/:id` | Revoke (the last active key can't be revoked) |
| POST | `/v1/invoices` | Create |
| GET | `/v1/invoices` | List; `status`, `created_from`, `created_to`, `limit`, `cursor` |
| GET | `/v1/invoices/:id` | Invoice + settlements |
| POST | `/v1/invoices/:id/cancel` | Cancel a pending invoice |
| GET / POST | `/v1/merchants/me/webhook-secret` (`/rotate`) | Webhook signing secret |
| GET | `/v1/checkout/:invoice_id` | Public; payment options and status, no merchant email or buyer PII |
| POST | `/v1/checkout/:invoice_id/quote` | Public; amount at par for a chain/token |
| POST | `/v1/checkout/:invoice_id/onchain-intent` | Public; screens payer, returns the exact amount to send |
| POST | `/internal/webhooks/chain-indexer/{alchemy,helius}` | Indexer notifications (signature-verified) |
| GET | `/v1/merchants/me/partner` | KYB status, payout bank account, liquidation addresses |
| POST | `/v1/merchants/me/partner/onboarding` | Start/resume KYB at Bridge |
| POST | `/v1/merchants/me/partner/bank-account` | Register payout bank account (US or IBAN) |
| POST | `/v1/checkout/:invoice_id/fiat-session` | Public; bank transfer instructions or signed card widget URL |
| POST | `/internal/webhooks/{bridge,moonpay}` | Partner notifications (signature-verified) |
| POST | `/v1/invoices/:id/resend` | Re-email the checkout link (throttled) |
| GET | `/v1/settlements` | Settlements; `invoice_id`, `rail`, `from`, `to`, `limit`, `cursor` |
| GET | `/v1/reports/export?format=csv&from=&to=` | CSV of confirmed settlements |
| GET | `/v1/unmatched-transfers` | Transfers awaiting manual reconciliation (`status=open|assigned|dismissed`) |
| POST | `/v1/unmatched-transfers/:id/{assign,dismiss}` | Assign to an invoice (re-verified on-chain) or dismiss |

## How on-chain payments work (Phase 2)

```
buyer picks chain+token ─▶ POST /v1/checkout/:id/onchain-intent
                              │  screens payer wallet (sanctions)
                              │  reserves a unique amount: $1,200.00 → 1200.007257 USDC
                              ▼
buyer's wallet signs ERC-20/SPL transfer ──────────────▶ merchant's own wallet
                                                         (coin.new is never in the path)
Alchemy / Helius webhook ─▶ inbound_events (signature-verified, stored verbatim)
fallback scanner (transfers index / signatures) ─┘
                                                  ▼
worker: read the tx from the chain via RPC ─▶ match (chain, token, to, exact amount)
        < N confirmations → invoice "processing"
        ≥ N confirmations → invoice "paid", settlement row, signed merchant webhooks
        tx vanished (reorg) → revert to "pending"
```

- **Webhook as trigger, RPC as truth.** Indexer payloads only tell us which transaction to look
  at. Nothing is marked paid unless an RPC read of the chain shows the transfer.
- **Why a unique amount:** ERC-20 and SPL transfers carry no memo. Each intent adds a random
  sub-cent reference (≤ $0.009999). Up to 9,999 open intents per (chain, token, receiving address).
  Intents keep matching late payments for 24h, then free their slot.
- **Tokens:** official issuances only. USDC on Ethereum/Base/Polygon/Solana; USDT on
  Ethereum/Polygon/Solana (not Base). Testnets: Circle test USDC. One deliberate exception, on
  Robinhood Chain (below).
- **Confirmations:** Ethereum 3, Base 3, Polygon 16 (history of deep reorgs), Robinhood Chain 60
  (~0.1s blocks, so ~6s), Solana `finalized`.
- **Fallback scanner:** every 30s, for receiving addresses with open intents. On Alchemy it reads
  `alchemy_getAssetTransfers` (paginated, from the intent's start block): Alchemy's free tier caps
  `eth_getLogs` at a 10-block range, which would otherwise disable the fallback on every EVM chain.
  Other providers use bounded `eth_getLogs`. Transfers already settled or in the reconciliation
  inbox aren't re-verified.

### Robinhood Chain (opt-in)

Robinhood Chain (Arbitrum Orbit L2, chain id 4663) is never enabled by default; a merchant turns it
on in Settings. Two tokens, both verified on-chain:

| Token | Contract | Notes |
|---|---|---|
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | Global Dollar (Paxos), the chain's native stablecoin |
| USDC | `0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8` | **Bridged**, not issued by Circle: the address the L2GatewayRouter derives for Ethereum USDC; `l1Address()` returns Ethereum USDC |

Bridged USDC is the one exception to "official issuances only", by product decision. It carries
bridge risk and, at launch, very little supply on the chain, so it is flagged `bridged: true` in
checkout options and holdings, and checkout warns the buyer. Robinhood Chain is not covered by
Bridge fiat payout or MoonPay, and it isn't registered with Alchemy Notify (support unverified);
the fallback scanner detects its payments. Testnet has no verified stablecoin contracts yet, so it
offers no payment options.
- **Merchant webhooks:** `invoice.paid`, `invoice.canceled`, `settlement.confirmed`, signed
  `X-coinnew-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Retries with backoff
  for 24h, then dead-lettered. URLs resolving to private/internal IPs are refused (SSRF).
- **Sanctions screening:** payer wallets are screened when an intent is created (blocked → 403),
  and the actual sender is screened at settlement (flagged, since the funds are already with the
  merchant). Chainalysis' free API plus a local denylist; pluggable.

## Fiat rails via licensed partners (Phase 3)

| Flow | Partner | How it works | Who holds funds |
|---|---|---|---|
| Merchant KYB | Bridge | Hosted KYB + ToS links; status passed through (webhook + throttled pull) | — |
| Buyer pays by bank transfer | Bridge | One Bridge transfer per invoice, on behalf of the merchant; buyer gets bank details + unique reference; Bridge settles USDC to the merchant wallet or fiat to the merchant bank | Bridge |
| Buyer pays by card | MoonPay | Signed widget URL delivering the exact amount to the merchant's receiving address; completion is verified **on-chain** before settling | MoonPay → merchant |
| Merchant paid in fiat | Bridge | Liquidation addresses per (chain, token) become the checkout address; Bridge converts and pays the merchant's bank | Bridge |

Partner webhooks follow the same rule as chain indexers: signature-verified (Bridge RSA-SHA256,
MoonPay HMAC, both with timestamp replay windows), stored verbatim in `partner_events`, and acted
on only after re-reading state from the partner's API (Bridge) or the chain (MoonPay).
Bank account numbers pass through to Bridge; coin.new stores only the partner's account id and last 4.

**Verify against partner sandboxes before go-live** (built against published docs; sandboxes weren't
reachable from the build environment):
- Bridge: request/response field names for `kyc_links`, `external_accounts`, `liquidation_addresses`,
  `transfers` (`source_deposit_instructions`, `receipt`), webhook signature header format.
- Bridge: that third-party deposits (the buyer, not the merchant, funding a transfer made on behalf of
  the merchant) are permitted for your program, and any sender-name requirements per rail.
- MoonPay: currency codes (`usdc_base`, `usdc_polygon`, …) and that delivery to a third-party
  (merchant) wallet is allowed under your MoonPay agreement; standard on-ramp terms require the
  buyer to own the destination wallet. If not, use MoonPay's merchant/commerce product or drop card.

## Reconciliation, reporting and notifications (Phase 4)

- **Settlements API** (`GET /v1/settlements`, filter by invoice, rail and date, with cursor paging) and an
  accountant-ready **CSV export** (`GET /v1/reports/export?format=csv&from=&to=`, at most 366 days).
  Cells starting with `= + - @` are escaped: invoice numbers, buyer emails and metadata are user-controlled,
  and spreadsheets would otherwise execute them as formulas.
- **Unmatched transfers.** Stablecoin transfers that reach a merchant's receiving address (or Bridge
  liquidation address) but match no intent are kept, not dropped. Typical causes: an exchange deducted
  a withdrawal fee, or the buyer paid without using checkout. The merchant assigns each one to an invoice
  or dismisses it. On assignment the transfer is re-verified on-chain and must be final; the settlement
  carries a `manual_match` flag, and the dashboard shows any shortfall.
- **Invoice expiry** is persisted by a job, which emits `invoice.expired` exactly once.
- **Email via Resend**, through an outbox with retries. Buyers get the invoice (on create, or on
  `POST /v1/invoices/:id/resend`, limited to once per 10 minutes and 5 times a day), a reminder 24h
  before expiry, and a receipt. Merchants get a payment notification, marked "[Review]" only for real
  risk flags. Merchant-controlled text is HTML-escaped. Without `RESEND_API_KEY`, emails are logged instead.
- **Hardening:**
  - Every worker job is safe to run as multiple processes (`FOR UPDATE SKIP LOCKED` plus leases, and
    state transitions as conditional UPDATEs).
  - Retries back off.
  - Abandoned in-flight idempotency keys can be taken over after 60 seconds, and expired keys are purged.
  - Finality checks always read the current chain head.

## Indexer address registration (Alchemy Notify)

With `ALCHEMY_AUTH_TOKEN` and `PUBLIC_API_URL` set, the worker keeps Alchemy watching the right
addresses on its own. Every 30s it:

- computes the desired set per EVM network: merchant wallets with that chain enabled, Bridge
  liquidation addresses, and any address an open payment intent still points to, so a wallet change
  can't orphan an in-flight payment;
- creates, or adopts, one Address Activity webhook per network, storing each signing key for inbound
  verification;
- adds or removes the difference in batches.

Every 6h it re-reads Alchemy's own list to heal drift. A Postgres advisory lock keeps it to one runner
at a time, and a webhook deleted on Alchemy's side is recreated on the next run. Solana (Helius) is
still registered by hand; the fallback scanner covers open intents either way.

## Wallet balance

The Payments page shows the USDC/USDT sitting in the merchant's own receiving wallets
(`GET /v1/merchants/me/holdings`). It is a read-only `balanceOf` / token-account read over the same RPC
the verifier uses, so it works with any provider, not only Alchemy.

- Only the registry's official contracts are queried. Wallets routinely receive spoofed "USDC" and
  look-alike airdrops, and a token's symbol proves nothing.
- Every chain the wallet can hold funds on is shown, including chains checkout no longer accepts, so
  funds are never hidden.
- A chain that can't be read is shown as such and the total is marked incomplete; one RPC outage never
  fails the card, and a card failure never breaks the page.
- The total is summed exactly and truncated to cents, never rounded up. Results are cached 30s per
  merchant to protect RPC quota.

## Compliance posture

coin.new is built to be jurisdiction-neutral: no market-specific logic in the codebase. The
non-custodial architecture keeps it out of money-transmission/VASP scope in many jurisdictions,
but that's an architecture choice, not a legal guarantee. Get counsel sign-off per launch market
(spec §7.5) and keep sanctions screening on everywhere.

## Decisions and deviations from the spec

- **One receiving wallet per chain family** (`receiving_wallets: { evm, solana }`) replaces
  `default_receiving_wallet`. EVM addresses must carry a valid EIP-55 checksum if mixed-case:
  a checksum failure is almost always a typo in a payout address.
- **Postgres-backed jobs instead of Redis/BullMQ.** They're safe to run as several worker processes;
  moving to a dedicated queue is only a throughput decision.
- **Exact-amount matching**, plus manual reconciliation. Transfers that don't match exactly land in the
  unmatched-transfers inbox for the merchant to assign.
- **`merchants.api_key_hash` dropped.** Keys live only in `api_keys` (rotation/revocation).
  Keys are `cn_<key id>_<secret>` so auth is a single row lookup plus one argon2id verify.
- **Invoice expiry is applied on read** (`pending` past `expires_at` reports `expired`) until the
  Phase 4 job persists it. Filters use the same rule.
- **Invoices are USD-denominated**; bank transfers are USD (ACH/wire) for now. EUR/SEPA pay-in with FX
  quoting is a follow-up; merchants can already receive EUR payouts to an IBAN.
- **Dashboard auth is a stand-in:** the session is the API key in an httpOnly cookie. Replace with
  Clerk or Supabase Auth (spec §5.7) before GA.
