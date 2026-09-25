-- Automatic registration of watched addresses with Alchemy Notify.

-- One Address Activity webhook per EVM network, created or adopted by the worker.
-- signing_key verifies inbound deliveries (HMAC). Inbound payloads are only
-- triggers (payments are verified on-chain), which bounds the impact of a leak.
CREATE TABLE alchemy_webhooks (
  alchemy_network TEXT PRIMARY KEY,           -- e.g. BASE_MAINNET
  webhook_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  last_full_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Our record of what Alchemy is watching (lowercased), reconciled against the desired set.
CREATE TABLE alchemy_watched_addresses (
  alchemy_network TEXT NOT NULL REFERENCES alchemy_webhooks(alchemy_network) ON DELETE CASCADE,
  address TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alchemy_network, address)
);
