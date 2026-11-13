import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  globallyPaused: boolean("globally_paused").notNull().default(false),
  revocationEpoch: bigint("revocation_epoch", { mode: "number" }).notNull().default(0),
  ...timestamps,
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    identitySubject: text("identity_subject").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_tenant_subject_unique").on(
      table.tenantId,
      table.identitySubject,
    ),
  ],
);

export const clientInstallations = pgTable(
  "client_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    clientId: text("client_id").notNull(),
    clientType: text("client_type").notNull(),
    refreshTokenHash: text("refresh_token_hash"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("client_installations_user_idx").on(table.tenantId, table.userId)],
);

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    encryptedDisplayAddress: text("encrypted_display_address").notNull(),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull(),
    paused: boolean("paused").notNull().default(false),
    credentialVersion: integer("credential_version").notNull().default(1),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("connected_accounts_provider_subject_unique").on(
      table.tenantId,
      table.provider,
      table.providerSubject,
    ),
  ],
);

export const providerCredentials = pgTable("provider_credentials", {
  accountId: uuid("account_id").primaryKey().references(() => connectedAccounts.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  wrappedKey: text("wrapped_key").notNull(),
  keyVersion: integer("key_version").notNull(),
  credentialVersion: integer("credential_version").notNull(),
  ...timestamps,
});

export const accountPolicies = pgTable(
  "account_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    installationId: uuid("installation_id").notNull().references(() => clientInstallations.id),
    accountId: uuid("account_id").notNull().references(() => connectedAccounts.id),
    permissions: jsonb("permissions").$type<Record<string, boolean>>().notNull(),
    constraints: jsonb("constraints").$type<Record<string, unknown>>().notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("account_policies_installation_account_unique").on(
      table.installationId,
      table.accountId,
    ),
  ],
);

export const approvalEnvelopes = pgTable(
  "approval_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    installationId: uuid("installation_id").notNull().references(() => clientInstallations.id),
    accountId: uuid("account_id").notNull().references(() => connectedAccounts.id),
    providerDraftId: text("provider_draft_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    encryptedEnvelope: text("encrypted_envelope").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    nonce: text("nonce").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("approval_envelopes_expiry_idx").on(table.state, table.expiresAt),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    installationId: uuid("installation_id").references(() => clientInstallations.id),
    accountId: uuid("account_id").references(() => connectedAccounts.id),
    operation: text("operation").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    policyVersion: bigint("policy_version", { mode: "number" }).notNull(),
    requestId: text("request_id").notNull(),
    resultCount: integer("result_count"),
    providerResultClass: text("provider_result_class"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_tenant_time_idx").on(table.tenantId, table.occurredAt)],
);

export const syncState = pgTable("sync_state", {
  accountId: uuid("account_id").primaryKey().references(() => connectedAccounts.id),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  providerSubscriptionId: text("provider_subscription_id"),
  encryptedCursor: text("encrypted_cursor"),
  subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
  lastNotificationAt: timestamp("last_notification_at", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  health: text("health").notNull().default("not_configured"),
  ...timestamps,
});

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    accountId: uuid("account_id").notNull().references(() => connectedAccounts.id),
    operation: text("operation").notNull(),
    windowId: bigint("window_id", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("rate_limit_buckets_cleanup_idx").on(table.windowId)],
);
