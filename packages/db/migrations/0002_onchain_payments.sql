-- Phase 2: on-chain payment path.

-- One receiving address per chain family (an EVM address cannot receive on
-- Solana and vice versa). Both are merchant-controlled; coin.new holds no keys.
ALTER TABLE merchants ADD COLUMN evm_wallet TEXT;
ALTER TABLE merchants ADD COLUMN solana_wallet TEXT;
UPDATE merchants SET evm_wallet = default_receiving_wallet WHERE default_receiving_wallet LIKE '0x%';
UPDATE merchants SET solana_wallet = default_receiving_wallet WHERE default_receiving_wallet NOT LIKE '0x%';
ALTER TABLE merchants DROP COLUMN default_receiving_wallet;
ALTER TABLE merchants ADD CONSTRAINT merchants_has_wallet CHECK (evm_wallet IS NOT NULL OR solana_wallet IS NOT NULL);

-- HMAC secret for signing outbound webhooks (spec §4). Not a wallet key.
ALTER TABLE merchants ADD COLUMN webhook_signing_secret TEXT;

-- What the checkout told a buyer to send, so an incoming transfer can be
-- matched to an invoice. ERC-20/SPL transfers carry no memo, so each intent
-- has a unique sub-cent amount per (chain, token, receiving address).
-- This is an expectation to watch for, not a transfer coin.new performs.
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  token_address TEXT NOT NULL,
  decimals INT NOT NULL,
  to_address TEXT NOT NULL,                   -- snapshot of the merchant's address at intent time
  amount_units NUMERIC(78,0) NOT NULL,
  payer_address TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'closed')),
  start_block NUMERIC(78,0),                  -- chain head at creation, for fallback scanning
  expires_at TIMESTAMPTZ NOT NULL,            -- shown to the buyer; late payments still match until closed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_intents_open_amount_uidx ON payment_intents (chain, lower(token_address), lower(to_address), amount_units) WHERE status = 'open';
CREATE INDEX payment_intents_invoice_idx ON payment_intents (invoice_id);
CREATE INDEX payment_intents_open_idx ON payment_intents (status, created_at) WHERE status = 'open';

ALTER TABLE settlements ADD COLUMN intent_id UUID REFERENCES payment_intents(id);
ALTER TABLE settlements ADD COLUMN log_index INT;
ALTER TABLE settlements ADD COLUMN risk_flags TEXT[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX settlements_onchain_uidx ON settlements (chain, tx_hash, coalesce(log_index, -1), to_address) WHERE rail = 'onchain';

-- Outbound webhook delivery with retry/backoff; 'failed' is the dead letter.
ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE webhook_deliveries ADD COLUMN last_error TEXT;
ALTER TABLE webhook_deliveries ADD COLUMN response_status INT;
ALTER TABLE webhook_deliveries ADD COLUMN delivered_at TIMESTAMPTZ;
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Inbound indexer notifications (Alchemy/Helius), stored verbatim before
-- processing. They are triggers only: payments are verified against the chain.
CREATE TABLE inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                       -- 'alchemy' | 'helius'
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash)
);
CREATE INDEX inbound_events_pending_idx ON inbound_events (received_at) WHERE processed_at IS NULL;
