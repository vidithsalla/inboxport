export type AccountState = "connected" | "disconnected" | "revocation_pending";
export type AccountHealth = "healthy" | "reauthorization_required" | "provider_error" | "revocation_pending";
export type MailProvider = "gmail" | "microsoft";

export type StoredMailAccount = Readonly<{
  id: string;
  userId: string;
  provider: MailProvider;
  providerSubjectHash: string;
  encryptedAddress: string;
  credentialEnvelope: string | null;
  scopes: readonly string[];
  paused: boolean;
  state: AccountState;
  health: AccountHealth;
  historyId: string | null;
  createdAt: string;
  updatedAt: string;
  disconnectedAt: string | null;
}>;

export type StoredAuditEvent = Readonly<{
  id: string;
  occurredAt: string;
  userId: string;
  installationId: string;
  accountId: string | null;
  operation: string;
  decision: string;
  reasonCode: string;
  policyVersion: number;
  requestId: string;
  resultCount: number | null;
  providerResultClass: string | null;
}>;

export type StoredInstallation = Readonly<{
  id: string;
  userId: string;
  clientId: string;
  clientName: string | null;
  revoked: boolean;
  revocationEpoch: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}>;

export type StoredGrantConstraints = Readonly<{
  deniedLabelIds: readonly string[];
  maxResults: number;
  maxBytes: number;
}>;

export type StoredAccountGrant = Readonly<{
  id: string;
  installationId: string;
  accountId: string;
  permissions: Readonly<Record<string, boolean>>;
  constraints: StoredGrantConstraints;
  createdAt: string;
  updatedAt: string;
}>;

export type StoredApprovalEnvelope = Readonly<{
  id: string;
  userId: string;
  installationId: string;
  accountId: string;
  providerDraftId: string;
  payloadHash: string;
  encryptedEnvelope: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}>;

export type StoredSyncState = Readonly<{
  accountId: string;
  userId: string;
  watchExpiresAt: string | null;
  lastNotificationAt: string | null;
  lastReconciledAt: string | null;
  health: string;
  createdAt: string;
  updatedAt: string;
}>;

export interface RelayRepository {
  listAccounts(userId: string): Promise<readonly StoredMailAccount[]>;
  getAccount(userId: string, accountId: string): Promise<StoredMailAccount | null>;
  findAccountByProviderSubject(
    userId: string,
    provider: MailProvider,
    providerSubjectHash: string,
  ): Promise<StoredMailAccount | null>;
  upsertAccount(account: StoredMailAccount): Promise<void>;
  setAccountPaused(userId: string, accountId: string, paused: boolean): Promise<boolean>;
  setAccountHealth(
    userId: string,
    accountId: string,
    health: AccountHealth,
  ): Promise<boolean>;
  finishDisconnect(
    userId: string,
    accountId: string,
    state: "disconnected" | "revocation_pending",
  ): Promise<boolean>;
  consumeRateLimit(
    userId: string,
    accountId: string,
    operation: string,
    limit: number,
    windowSeconds: number,
    now?: Date,
  ): Promise<Readonly<{ allowed: boolean; remaining: number; resetAt: string }>>;
  appendAudit(event: StoredAuditEvent): Promise<void>;
  listAudit(userId: string, limit: number): Promise<readonly StoredAuditEvent[]>;

  getOrCreateInstallation(
    userId: string,
    clientId: string,
    clientName: string | null,
  ): Promise<Readonly<{ installation: StoredInstallation; created: boolean }>>;
  listInstallations(userId: string): Promise<readonly StoredInstallation[]>;
  getInstallation(userId: string, installationId: string): Promise<StoredInstallation | null>;
  setInstallationName(
    userId: string,
    installationId: string,
    clientName: string,
  ): Promise<boolean>;
  setInstallationRevoked(
    userId: string,
    installationId: string,
    revoked: boolean,
  ): Promise<boolean>;
  touchInstallation(installationId: string): Promise<void>;

  upsertAccountGrant(
    installationId: string,
    accountId: string,
    permissions: Readonly<Record<string, boolean>>,
    constraints: StoredGrantConstraints,
  ): Promise<void>;
  revokeAccountGrant(installationId: string, accountId: string): Promise<boolean>;
  listAccountGrants(installationId: string): Promise<readonly StoredAccountGrant[]>;
  getAccountGrant(
    installationId: string,
    accountId: string,
  ): Promise<StoredAccountGrant | null>;

  createApprovalEnvelope(envelope: StoredApprovalEnvelope): Promise<void>;
  getApprovalEnvelope(userId: string, id: string): Promise<StoredApprovalEnvelope | null>;
  /** Excludes envelopes past `expiresAt`; opportunistically deletes them instead of returning them. */
  listApprovalEnvelopes(userId: string): Promise<readonly StoredApprovalEnvelope[]>;
  /** Transitions only if the row's current state is one of `fromStates`; returns false otherwise (race-safe). */
  transitionApprovalEnvelope(
    userId: string,
    id: string,
    fromStates: readonly string[],
    toState: string,
    /**
     * When set (ISO timestamp), the transition only succeeds if the envelope
     * has not expired as of that instant -- used to make the forward
     * approve/dispatch transitions atomic with the ten-minute expiry so a
     * decision cannot slip through just after expiry.
     */
    notExpiredAsOf?: string,
  ): Promise<boolean>;
  deleteApprovalEnvelope(userId: string, id: string): Promise<void>;

  /**
   * System-level lookup with no user scoping: used only by the Gmail push webhook, which
   * knows only a Google account address, not which Relay user owns it. Excludes paused
   * accounts -- pausing means "blocked," including from this background sync path, not
   * only from live MCP calls (see policy.ts's ACCOUNT_PAUSED gate for the same rule
   * applied to foreground access).
   */
  findAccountsByProviderSubjectHash(
    provider: MailProvider,
    providerSubjectHash: string,
  ): Promise<readonly StoredMailAccount[]>;
  /**
   * System-level listing with no user scoping: used only by the daily watch-renewal
   * cron. Excludes paused accounts for the same reason as findAccountsByProviderSubjectHash.
   */
  listAllConnectedAccounts(provider: MailProvider): Promise<readonly StoredMailAccount[]>;
  updateAccountHistoryId(userId: string, accountId: string, historyId: string): Promise<void>;
  /** Replaces the stored, encrypted refresh credential, e.g. after a provider rotates it on refresh. */
  updateAccountCredential(userId: string, accountId: string, credentialEnvelope: string): Promise<void>;

  getSyncState(accountId: string): Promise<StoredSyncState | null>;
  upsertSyncState(state: StoredSyncState): Promise<void>;
}
