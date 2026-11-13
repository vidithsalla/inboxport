import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const relayAccounts = sqliteTable(
  "relay_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    providerSubjectHash: text("provider_subject_hash").notNull(),
    encryptedAddress: text("encrypted_address").notNull(),
    credentialEnvelope: text("credential_envelope"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    state: text("state").notNull().default("connected"),
    health: text("health").notNull().default("healthy"),
    historyId: text("history_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    disconnectedAt: text("disconnected_at"),
  },
  (table) => [
    uniqueIndex("relay_accounts_user_provider_subject_unique").on(
      table.userId,
      table.provider,
      table.providerSubjectHash,
    ),
    index("relay_accounts_user_state_idx").on(table.userId, table.state),
  ],
);

export const relayAuditEvents = sqliteTable(
  "relay_audit_events",
  {
    id: text("id").primaryKey(),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    userId: text("user_id").notNull(),
    installationId: text("installation_id").notNull(),
    accountId: text("account_id"),
    operation: text("operation").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersion: integer("policy_version").notNull(),
    requestId: text("request_id").notNull(),
    resultCount: integer("result_count"),
    providerResultClass: text("provider_result_class"),
  },
  (table) => [
    index("relay_audit_user_time_idx").on(table.userId, table.occurredAt),
    index("relay_audit_account_time_idx").on(table.accountId, table.occurredAt),
  ],
);

export const relayRateLimits = sqliteTable(
  "relay_rate_limits",
  {
    key: text("key").primaryKey(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull(),
    operation: text("operation").notNull(),
    windowId: integer("window_id").notNull(),
    count: integer("count").notNull().default(1),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("relay_rate_limits_cleanup_idx").on(table.windowId)],
);

/**
 * One row per remote MCP client connection (installation). `clientId` is the
 * OAuth client identifier Clerk issues to that connecting client (distinct
 * per Claude/ChatGPT/etc. installation, not the Relay console user).
 */
export const relayInstallations = sqliteTable(
  "relay_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    clientName: text("client_name"),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    revocationEpoch: integer("revocation_epoch").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at"),
  },
  (table) => [
    uniqueIndex("relay_installations_user_client_unique").on(table.userId, table.clientId),
    index("relay_installations_user_idx").on(table.userId),
  ],
);

/**
 * Explicit, per-installation, per-account permission grant. No row means no
 * access: an installation must be granted an account before any MCP tool can
 * name it. `permissions` mirrors `MailPermission` from lib/relay/contracts.ts.
 */
export const relayAccountGrants = sqliteTable(
  "relay_account_grants",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id").notNull(),
    accountId: text("account_id").notNull(),
    permissions: text("permissions", { mode: "json" })
      .$type<Record<string, boolean>>()
      .notNull(),
    constraints: text("constraints", { mode: "json" })
      .$type<{ deniedLabelIds: string[]; maxResults: number; maxBytes: number }>()
      .notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("relay_account_grants_installation_account_unique").on(
      table.installationId,
      table.accountId,
    ),
    index("relay_account_grants_account_idx").on(table.accountId),
  ],
);

/**
 * Encrypted, single-use, maximum-ten-minute approval envelope (Phase 5).
 * Deleted on send, denial, cancellation, or expiry; `delivery_unknown` rows
 * are kept read-only until their natural expiry so a human can check the
 * provider before the row is reaped -- never retried automatically.
 */
export const relayApprovalEnvelopes = sqliteTable(
  "relay_approval_envelopes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    installationId: text("installation_id").notNull(),
    accountId: text("account_id").notNull(),
    providerDraftId: text("provider_draft_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    encryptedEnvelope: text("encrypted_envelope").notNull(),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("relay_approval_envelopes_user_state_idx").on(table.userId, table.state),
    index("relay_approval_envelopes_expiry_idx").on(table.expiresAt),
  ],
);

/**
 * Gmail push-notification watch/reconciliation state (Phase 6). Holds no
 * mail content -- only the operational state of the account's `users.watch`
 * registration and when it was last reconciled against Gmail's history.
 */
export const relaySyncState = sqliteTable(
  "relay_sync_state",
  {
    accountId: text("account_id").primaryKey(),
    userId: text("user_id").notNull(),
    watchExpiresAt: text("watch_expires_at"),
    lastNotificationAt: text("last_notification_at"),
    lastReconciledAt: text("last_reconciled_at"),
    health: text("health").notNull().default("not_configured"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("relay_sync_state_watch_expiry_idx").on(table.watchExpiresAt),
    index("relay_sync_state_user_idx").on(table.userId),
  ],
);
