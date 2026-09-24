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
| 2 | Wallet connect, direct USDC/USDT transfer, Alchemy/Helius matching, merchant webhooks | — |
| 3 | Partner rail (Bridge/Circle) fiat on-ramp, MoonPay fallback, fiat payout | — |
| 4 | Settlements API, CSV export, expiry jobs, resend + email | — |
| 5 | Optional audited forwarder contract | — |

## Layout

```
apps/api          Fastify REST API (Zod validation, argon2 API keys, idempotency, rate limits)
apps/dashboard    Next.js 14 merchant dashboard           :3000
apps/checkout     Next.js 14 hosted buyer checkout        :3001
packages/db       SQL migrations + Drizzle schema (Postgres; PGlite for tests)
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

## API (Phase 1)

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
| GET | `/v1/checkout/:invoice_id` | Public; no merchant email or buyer PII |

## Decisions and deviations from the spec

- **One receiving wallet = one chain family.** An EVM address can't receive on Solana and
  vice versa, so `preferred_chains` defaults from the wallet's family and mismatches are
  rejected. Merchants need a wallet per family before Phase 2 enables Solana alongside EVM.
- **`merchants.api_key_hash` dropped.** Keys live only in `api_keys` (rotation/revocation).
  Keys are `cn_<key id>_<secret>` so auth is a single row lookup plus one argon2id verify.
- **Invoice expiry is applied on read** (`pending` past `expires_at` reports `expired`) until the
  Phase 4 job persists it. Filters use the same rule.
- **`fiat_via_partner` payout is rejected** until a partner rail customer exists (Phase 3).
- **Dashboard auth is a stand-in:** the session is the API key in an httpOnly cookie. Replace with
  Clerk or Supabase Auth (spec §5.7) before GA.
- **`/v1/invoices/:id/resend`** is deferred to Phase 4 alongside email delivery.
