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
| 3 | Partner rail (Bridge/Circle) fiat on-ramp, MoonPay fallback, fiat payout | — |
| 4 | Settlements API, CSV export, expiry jobs, resend + email | — |
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

## How on-chain payments work (Phase 2)

```
buyer picks chain+token ─▶ POST /v1/checkout/:id/onchain-intent
                              │  screens payer wallet (sanctions)
                              │  reserves a unique amount: $1,200.00 → 1200.007257 USDC
                              ▼
buyer's wallet signs ERC-20/SPL transfer ──────────────▶ merchant's own wallet
                                                         (coin.new is never in the path)
Alchemy / Helius webhook ─▶ inbound_events (signature-verified, stored verbatim)
fallback scanner (getLogs / signatures) ─┘       │
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
  Ethereum/Polygon/Solana (not Base). Testnets: Circle test USDC.
- **Confirmations:** Ethereum 3, Base 3, Polygon 16 (history of deep reorgs), Solana `finalized`.
- **Merchant webhooks:** `invoice.paid`, `invoice.canceled`, `settlement.confirmed`, signed
  `X-coinnew-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Retries with backoff
  for 24h, then dead-lettered. URLs resolving to private/internal IPs are refused (SSRF).
- **Sanctions screening:** payer wallets are screened when an intent is created (blocked → 403),
  and the actual sender is screened at settlement (flagged, since the funds are already with the
  merchant). Chainalysis' free API plus a local denylist; pluggable.

## Compliance posture

coin.new is built to be jurisdiction-neutral: no market-specific logic in the codebase. The
non-custodial architecture keeps it out of money-transmission/VASP scope in many jurisdictions,
but that's an architecture choice, not a legal guarantee. Get counsel sign-off per launch market
(spec §7.5) and keep sanctions screening on everywhere.

## Decisions and deviations from the spec

- **One receiving wallet per chain family** (`receiving_wallets: { evm, solana }`) replaces
  `default_receiving_wallet`. EVM addresses must carry a valid EIP-55 checksum if mixed-case:
  a checksum failure is almost always a typo in a payout address.
- **Postgres-backed jobs instead of Redis/BullMQ** for now (inbound events, confirmations, fallback
  scan, webhook delivery). Run a single worker process; move to BullMQ when volume needs it.
- **Exact-amount matching only.** Underpayments, overpayments, or exchange withdrawals that deduct
  fees don't match automatically; surfacing unmatched transfers for manual reconciliation is Phase 4.
- **`merchants.api_key_hash` dropped.** Keys live only in `api_keys` (rotation/revocation).
  Keys are `cn_<key id>_<secret>` so auth is a single row lookup plus one argon2id verify.
- **Invoice expiry is applied on read** (`pending` past `expires_at` reports `expired`) until the
  Phase 4 job persists it. Filters use the same rule.
- **`fiat_via_partner` payout is rejected** until a partner rail customer exists (Phase 3).
- **Dashboard auth is a stand-in:** the session is the API key in an httpOnly cookie. Replace with
  Clerk or Supabase Auth (spec §5.7) before GA.
- **`/v1/invoices/:id/resend`** is deferred to Phase 4 alongside email delivery.
