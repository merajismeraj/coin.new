-- Phase 4: reconciliation, reporting, notifications, hardening.

-- Expiry reminders are sent once per invoice.
ALTER TABLE invoices ADD COLUMN reminder_sent_at TIMESTAMPTZ;
CREATE INDEX invoices_pending_expiry_idx ON invoices (expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;

-- Reporting reads settlements by confirmation time.
CREATE INDEX settlements_confirmed_idx ON settlements (confirmed_at);

-- Transfers that reached a merchant's receiving address but matched no
-- payment intent (wrong amount, exchange fee deducted, no checkout used).
-- The merchant reconciles them by hand: assign to an invoice, or dismiss.
CREATE TABLE unmatched_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INT,
  token TEXT NOT NULL,
  token_address TEXT NOT NULL,
  decimals INT NOT NULL,
  amount_units NUMERIC(78,0) NOT NULL,
  from_address TEXT,
  to_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'dismissed')),
  settlement_id UUID REFERENCES settlements(id),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX unmatched_transfers_uidx ON unmatched_transfers (chain, tx_hash, coalesce(log_index, -1), to_address);
CREATE INDEX unmatched_transfers_merchant_idx ON unmatched_transfers (merchant_id, status, observed_at DESC);

-- Transactional email outbox (Resend). Delivered by the worker with retries.
CREATE TABLE email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id),
  invoice_id UUID REFERENCES invoices(id),
  template TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  provider_id TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX email_outbox_invoice_idx ON email_outbox (invoice_id, template, created_at DESC);

-- Leases so several worker processes can run safely: a job claims rows by
-- pushing next_attempt_at forward under FOR UPDATE SKIP LOCKED.
ALTER TABLE inbound_events ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE partner_events ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
