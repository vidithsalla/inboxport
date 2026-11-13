import { assertStoredAuditEventSafe } from "../../../lib/relay/audit.ts";
import type {
  AccountHealth,
  MailProvider,
  RelayRepository,
  StoredAccountGrant,
  StoredApprovalEnvelope,
  StoredAuditEvent,
  StoredGrantConstraints,
  StoredInstallation,
  StoredMailAccount,
  StoredSyncState,
} from "../../../lib/relay/repository.ts";

export class MemoryRepository implements RelayRepository {
  accounts = new Map<string, StoredMailAccount>();
  audit: StoredAuditEvent[] = [];
  installations = new Map<string, StoredInstallation>();
  grants = new Map<string, StoredAccountGrant>();
  approvals = new Map<string, StoredApprovalEnvelope>();
  syncState = new Map<string, StoredSyncState>();

  private grantKey(installationId: string, accountId: string): string {
    return `${installationId}:${accountId}`;
  }

  async listAccounts(userId: string) {
    return [...this.accounts.values()].filter(
      (account) => account.userId === userId && account.state === "connected",
    );
  }
  async getAccount(userId: string, accountId: string) {
    const account = this.accounts.get(accountId);
    return account?.userId === userId ? account : null;
  }
  async findAccountByProviderSubject(userId: string, provider: MailProvider, hash: string) {
    return (
      [...this.accounts.values()].find(
        (account) =>
          account.userId === userId &&
          account.provider === provider &&
          account.providerSubjectHash === hash,
      ) ?? null
    );
  }
  async upsertAccount(account: StoredMailAccount) {
    this.accounts.set(account.id, account);
  }
  async setAccountPaused(userId: string, accountId: string, paused: boolean) {
    const account = await this.getAccount(userId, accountId);
    if (!account) return false;
    this.accounts.set(accountId, { ...account, paused });
    return true;
  }
  async setAccountHealth(userId: string, accountId: string, health: AccountHealth) {
    const account = await this.getAccount(userId, accountId);
    if (!account) return false;
    this.accounts.set(accountId, { ...account, health });
    return true;
  }
  async finishDisconnect(
    userId: string,
    accountId: string,
    state: "disconnected" | "revocation_pending",
  ) {
    const account = await this.getAccount(userId, accountId);
    if (!account) return false;
    this.accounts.set(accountId, {
      ...account,
      state,
      paused: true,
      credentialEnvelope: state === "disconnected" ? null : account.credentialEnvelope,
      encryptedAddress: state === "disconnected" ? "" : account.encryptedAddress,
    });
    for (const [key, grant] of this.grants) {
      if (grant.accountId === accountId) this.grants.delete(key);
    }
    return true;
  }
  async consumeRateLimit(
    _userId: string,
    _accountId: string,
    _operation: string,
    limit: number,
    windowSeconds: number,
    now = new Date(),
  ) {
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt: new Date(now.getTime() + windowSeconds * 1000).toISOString(),
    };
  }
  async appendAudit(event: StoredAuditEvent) {
    assertStoredAuditEventSafe(event);
    this.audit.push(event);
  }
  async listAudit(userId: string, limit: number) {
    return this.audit
      .filter((event) => event.userId === userId)
      .slice(-limit)
      .reverse();
  }

  async getOrCreateInstallation(userId: string, clientId: string, clientName: string | null) {
    const existing = [...this.installations.values()].find(
      (installation) => installation.userId === userId && installation.clientId === clientId,
    );
    if (existing) return { installation: existing, created: false };
    const now = new Date().toISOString();
    const installation: StoredInstallation = {
      id: crypto.randomUUID(),
      userId,
      clientId,
      clientName,
      revoked: false,
      revocationEpoch: 1,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.installations.set(installation.id, installation);
    return { installation, created: true };
  }
  async listInstallations(userId: string) {
    return [...this.installations.values()].filter(
      (installation) => installation.userId === userId,
    );
  }
  async getInstallation(userId: string, installationId: string) {
    const installation = this.installations.get(installationId);
    return installation?.userId === userId ? installation : null;
  }
  async setInstallationName(userId: string, installationId: string, clientName: string) {
    const installation = await this.getInstallation(userId, installationId);
    if (!installation) return false;
    this.installations.set(installationId, {
      ...installation,
      clientName,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
  async setInstallationRevoked(userId: string, installationId: string, revoked: boolean) {
    const installation = await this.getInstallation(userId, installationId);
    if (!installation) return false;
    this.installations.set(installationId, {
      ...installation,
      revoked,
      revocationEpoch: installation.revocationEpoch + 1,
    });
    return true;
  }
  async touchInstallation(installationId: string) {
    const installation = this.installations.get(installationId);
    if (!installation) return;
    this.installations.set(installationId, {
      ...installation,
      lastSeenAt: new Date().toISOString(),
    });
  }

  async upsertAccountGrant(
    installationId: string,
    accountId: string,
    permissions: Readonly<Record<string, boolean>>,
    constraints: StoredGrantConstraints,
  ) {
    const key = this.grantKey(installationId, accountId);
    const now = new Date().toISOString();
    const existing = this.grants.get(key);
    this.grants.set(key, {
      id: existing?.id ?? crypto.randomUUID(),
      installationId,
      accountId,
      permissions: { ...permissions },
      constraints,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
  async revokeAccountGrant(installationId: string, accountId: string) {
    return this.grants.delete(this.grantKey(installationId, accountId));
  }
  async listAccountGrants(installationId: string) {
    return [...this.grants.values()].filter((grant) => grant.installationId === installationId);
  }
  async getAccountGrant(installationId: string, accountId: string) {
    return this.grants.get(this.grantKey(installationId, accountId)) ?? null;
  }

  async createApprovalEnvelope(envelope: StoredApprovalEnvelope) {
    this.approvals.set(envelope.id, envelope);
  }
  async getApprovalEnvelope(userId: string, id: string) {
    const envelope = this.approvals.get(id);
    if (!envelope || envelope.userId !== userId) return null;
    if (new Date(envelope.expiresAt).getTime() <= Date.now()) {
      this.approvals.delete(id);
      return null;
    }
    return envelope;
  }
  async listApprovalEnvelopes(userId: string) {
    const now = Date.now();
    for (const [id, envelope] of this.approvals) {
      if (envelope.userId === userId && new Date(envelope.expiresAt).getTime() <= now) {
        this.approvals.delete(id);
      }
    }
    return [...this.approvals.values()].filter((envelope) => envelope.userId === userId);
  }
  async transitionApprovalEnvelope(
    userId: string,
    id: string,
    fromStates: readonly string[],
    toState: string,
    notExpiredAsOf?: string,
  ) {
    const envelope = this.approvals.get(id);
    if (!envelope || envelope.userId !== userId || !fromStates.includes(envelope.state)) {
      return false;
    }
    if (notExpiredAsOf && new Date(envelope.expiresAt).getTime() <= new Date(notExpiredAsOf).getTime()) {
      return false;
    }
    this.approvals.set(id, { ...envelope, state: toState, updatedAt: new Date().toISOString() });
    return true;
  }
  async deleteApprovalEnvelope(userId: string, id: string) {
    const envelope = this.approvals.get(id);
    if (envelope?.userId === userId) this.approvals.delete(id);
  }

  async findAccountsByProviderSubjectHash(provider: MailProvider, providerSubjectHash: string) {
    return [...this.accounts.values()].filter(
      (account) =>
        account.provider === provider &&
        account.providerSubjectHash === providerSubjectHash &&
        account.state === "connected" &&
        !account.paused,
    );
  }
  async listAllConnectedAccounts(provider: MailProvider) {
    return [...this.accounts.values()].filter(
      (account) => account.provider === provider && account.state === "connected" && !account.paused,
    );
  }
  async updateAccountHistoryId(userId: string, accountId: string, historyId: string) {
    const account = await this.getAccount(userId, accountId);
    if (!account) return;
    this.accounts.set(accountId, { ...account, historyId, updatedAt: new Date().toISOString() });
  }

  async updateAccountCredential(userId: string, accountId: string, credentialEnvelope: string) {
    const account = await this.getAccount(userId, accountId);
    if (!account) return;
    this.accounts.set(accountId, { ...account, credentialEnvelope, updatedAt: new Date().toISOString() });
  }

  async getSyncState(accountId: string) {
    return this.syncState.get(accountId) ?? null;
  }
  async upsertSyncState(state: StoredSyncState) {
    this.syncState.set(state.accountId, state);
  }
}
