import { integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Mirrors migrations/0001_init.sql. Keep the two in sync.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const merchants = pgTable("merchants", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessName: text("business_name").notNull(),
  email: text("email").notNull().unique(),
  countryCode: text("country_code").notNull(),
  defaultReceivingWallet: text("default_receiving_wallet").notNull(),
  preferredChains: text("preferred_chains").array().notNull(),
  payoutPreference: text("payout_preference").notNull().default("crypto"),
  partnerRailCustomerId: text("partner_rail_customer_id"),
  webhookUrl: text("webhook_url"),
  createdAt: createdAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
  keyHash: text("key_hash").notNull(),
  label: text("label"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
  invoiceNumber: text("invoice_number").notNull(),
  amountUsd: numeric("amount_usd", { precision: 18, scale: 2 }).notNull(),
  acceptedTokens: text("accepted_tokens").array().notNull(),
  acceptedChains: text("accepted_chains").array().notNull(),
  buyerEmail: text("buyer_email"),
  buyerWallet: text("buyer_wallet"),
  status: text("status").notNull().default("pending"),
  checkoutUrl: text("checkout_url").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const settlements = pgTable("settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  rail: text("rail").notNull(),
  chain: text("chain"),
  txHash: text("tx_hash"),
  token: text("token").notNull(),
  amount: numeric("amount", { precision: 38, scale: 18 }).notNull(),
  fromAddress: text("from_address"),
  toAddress: text("to_address").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  rawEvent: jsonb("raw_event").notNull(),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull().references(() => merchants.id),
  invoiceId: uuid("invoice_id").references(() => invoices.id),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: createdAt(),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);
