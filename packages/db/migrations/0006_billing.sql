-- coin.new subscription billing: a flat monthly plan that starts with a
-- merchant's first confirmed payment. Each period is billed as an ordinary
-- invoice issued by the platform's own merchant account, so it's paid through
-- the same non-custodial checkout and verified on-chain like any payment.

ALTER TABLE merchants ADD COLUMN billing_started_at TIMESTAMPTZ;

CREATE TABLE billing_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  amount_usd NUMERIC(18, 2) NOT NULL,
  -- The platform-issued invoice for this period; its status is the source of truth for payment.
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  due_at TIMESTAMPTZ NOT NULL,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One bill per merchant per period, even with concurrent job runners.
  UNIQUE (merchant_id, period_start)
);

CREATE INDEX billing_periods_merchant_idx ON billing_periods (merchant_id, period_start DESC);
