-- Phase 3: licensed partner rails (Bridge primary, MoonPay fallback).
-- Custody, KYC/KYB and fiat conversion happen at the partner. coin.new stores
-- references to the partner's objects and decisions, never documents or funds.

CREATE TABLE partner_accounts (
  merchant_id UUID PRIMARY KEY REFERENCES merchants(id),
  rail TEXT NOT NULL DEFAULT 'bridge',
  customer_id TEXT,                           -- Bridge customer (the merchant, after KYB)
  kyc_link_id TEXT,
  kyc_link_url TEXT,
  tos_link_url TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'not_started',
  tos_status TEXT NOT NULL DEFAULT 'pending',
  -- Payout bank account lives at Bridge; we keep only its id and display hints.
  external_account_id TEXT,
  external_account_last4 TEXT,
  external_account_rail TEXT,                 -- 'ach' | 'wire' | 'sepa'
  external_account_currency TEXT,             -- 'usd' | 'eur'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partner-controlled deposit addresses that convert stablecoins to fiat and pay
-- the merchant's bank. Used as the checkout address when payout is fiat.
CREATE TABLE liquidation_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  rail TEXT NOT NULL DEFAULT 'bridge',
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  address TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, chain, token, external_account_id)
);

-- A buyer's fiat payment attempt at a partner (bank transfer via Bridge, card via MoonPay).
CREATE TABLE partner_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  rail TEXT NOT NULL CHECK (rail IN ('bridge', 'moonpay')),
  method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'card')),
  external_id TEXT,                           -- Bridge transfer id / MoonPay transaction id (set on first event)
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'completed', 'failed')),
  chain TEXT,                                 -- card: where the crypto is delivered
  token TEXT,
  to_address TEXT,
  amount_units NUMERIC(78,0),
  instructions JSONB,                         -- bank deposit instructions shown to the buyer
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX partner_sessions_external_uidx ON partner_sessions (rail, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX partner_sessions_invoice_idx ON partner_sessions (invoice_id);

-- Partner webhooks, stored verbatim before processing (audit trail, spec §5.8).
CREATE TABLE partner_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, event_id)
);
CREATE INDEX partner_events_pending_idx ON partner_events (received_at) WHERE processed_at IS NULL;

ALTER TABLE settlements ADD COLUMN partner_session_id UUID REFERENCES partner_sessions(id);
CREATE UNIQUE INDEX settlements_partner_session_uidx ON settlements (partner_session_id) WHERE partner_session_id IS NOT NULL;
