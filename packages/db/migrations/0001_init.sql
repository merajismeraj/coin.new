-- Phase 1 schema (spec §3).
-- Deliberately absent: any table of fund balances, internally held wallets or
-- key material, or queued transfers. coin.new never custodies funds; every
-- money fact traces to a settlements.raw_event from a chain or partner rail.

CREATE TABLE merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  country_code TEXT NOT NULL,
  default_receiving_wallet TEXT NOT NULL,     -- merchant-controlled, never coin.new-controlled
  preferred_chains TEXT[] NOT NULL,
  payout_preference TEXT NOT NULL DEFAULT 'crypto' CHECK (payout_preference IN ('crypto', 'fiat_via_partner')),
  partner_rail_customer_id TEXT,              -- Circle/Bridge customer ref, if fiat payout enabled
  webhook_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  key_hash TEXT NOT NULL,                     -- argon2id; plaintext is shown once and never stored
  label TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  invoice_number TEXT NOT NULL,
  amount_usd NUMERIC(18,2) NOT NULL CHECK (amount_usd > 0),
  accepted_tokens TEXT[] NOT NULL DEFAULT '{USDC,USDT}',
  accepted_chains TEXT[] NOT NULL,
  buyer_email TEXT,
  buyer_wallet TEXT,                          -- filled once buyer connects
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'paid', 'expired', 'canceled')),
  checkout_url TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, invoice_number)
);
CREATE INDEX invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC, id DESC);

-- Read-only mirror of on-chain / partner-rail events; NEVER the source of truth for funds.
CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  rail TEXT NOT NULL CHECK (rail IN ('onchain', 'circle', 'bridge', 'moonpay')),
  chain TEXT,                                 -- null if fiat rail
  tx_hash TEXT,                               -- null if fiat rail
  token TEXT NOT NULL,
  amount NUMERIC(38,18) NOT NULL,
  from_address TEXT,
  to_address TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  raw_event JSONB NOT NULL,                   -- full webhook/log payload for audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX settlements_invoice_idx ON settlements (invoice_id);

CREATE TABLE webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  invoice_id UUID REFERENCES invoices(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency (spec §4): a duplicate key within 24h replays the original response.
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,                        -- merchant id, or 'public' for onboarding
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INT,                        -- null while the first request is in flight
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
