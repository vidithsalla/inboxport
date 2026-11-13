export const DEVELOPMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_subject_hash TEXT NOT NULL,
  encrypted_address TEXT NOT NULL,
  credential_envelope TEXT,
  scopes TEXT NOT NULL,
  paused INTEGER DEFAULT 0 NOT NULL,
  state TEXT DEFAULT 'connected' NOT NULL,
  health TEXT DEFAULT 'healthy' NOT NULL,
  history_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  disconnected_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_accounts_user_provider_subject_unique
  ON relay_accounts (user_id, provider, provider_subject_hash);
CREATE INDEX IF NOT EXISTS relay_accounts_user_state_idx
  ON relay_accounts (user_id, state);
CREATE TABLE IF NOT EXISTS relay_audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  account_id TEXT,
  operation TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  result_count INTEGER,
  provider_result_class TEXT
);
CREATE INDEX IF NOT EXISTS relay_audit_user_time_idx
  ON relay_audit_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS relay_audit_account_time_idx
  ON relay_audit_events (account_id, occurred_at);
CREATE TABLE IF NOT EXISTS relay_rate_limits (
  key TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_id INTEGER NOT NULL,
  count INTEGER DEFAULT 1 NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_rate_limits_cleanup_idx
  ON relay_rate_limits (window_id);
CREATE TABLE IF NOT EXISTS relay_installations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  revoked INTEGER DEFAULT 0 NOT NULL,
  revocation_epoch INTEGER DEFAULT 1 NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  last_seen_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_installations_user_client_unique
  ON relay_installations (user_id, client_id);
CREATE INDEX IF NOT EXISTS relay_installations_user_idx
  ON relay_installations (user_id);
CREATE TABLE IF NOT EXISTS relay_account_grants (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  permissions TEXT NOT NULL,
  constraints TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS relay_account_grants_installation_account_unique
  ON relay_account_grants (installation_id, account_id);
CREATE INDEX IF NOT EXISTS relay_account_grants_account_idx
  ON relay_account_grants (account_id);
CREATE TABLE IF NOT EXISTS relay_approval_envelopes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_draft_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  encrypted_envelope TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_approval_envelopes_user_state_idx
  ON relay_approval_envelopes (user_id, state);
CREATE INDEX IF NOT EXISTS relay_approval_envelopes_expiry_idx
  ON relay_approval_envelopes (expires_at);
CREATE TABLE IF NOT EXISTS relay_sync_state (
  account_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  watch_expires_at TEXT,
  last_notification_at TEXT,
  last_reconciled_at TEXT,
  health TEXT DEFAULT 'not_configured' NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_sync_state_watch_expiry_idx
  ON relay_sync_state (watch_expires_at);
CREATE INDEX IF NOT EXISTS relay_sync_state_user_idx
  ON relay_sync_state (user_id);
`;

let bootstrap: Promise<void> | null = null;

/** Development convenience only. Production uses reviewed migrations. */
export function ensureDevelopmentSchema(enabled: boolean): Promise<void> {
  if (!enabled) return Promise.resolve();
  bootstrap ??= import("./index.ts").then(({ getDbClient }) =>
    getDbClient().executeMultiple(DEVELOPMENT_SCHEMA),
  );
  return bootstrap;
}
